import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { AutomationScripts, LegacyScriptMappings } from '@ocs-server/common/automation';
import type { Config } from '@ocs-server/common';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
import type { BrowserProfile } from './types';
import type { BrowserAction, WorkerRequest, WorkerResponse, WorkerStart } from './protocol';
import { validateExtensions } from './extensions';
import { installBrowserBridge } from './browser-bridge';
import { createOCRProxy } from './ocr';
import { automationDiagnostic } from './automation-diagnostics';
import { prepareScriptManager, installManagedScripts, hasManagedScripts, isManagerPage } from './manager';
import { ResourceSampler } from './resource';
import { Screencast } from './screencast';

let browser: BrowserContext | undefined;
let starting = false;
let shuttingDown = false;
let profileId = '';
const pages = new Map<string, Page>();
let ocrProxy: Awaited<ReturnType<typeof createOCRProxy>> | undefined;
let resourceTimer: ReturnType<typeof setTimeout> | undefined;
let bridge: Awaited<ReturnType<typeof installBrowserBridge>> | undefined;
const screencast = new Screencast(
	(frame) => event('screencast-frame', { ...frame }),
	(pageId) => event('screencast-ended', { pageId })
);

function reportResources() {
	const sampler = new ResourceSampler();
	const sample = async () => {
		if (!browser || shuttingDown) return;
		try {
			const { memoryMB, cpuPercent, cpuTime } = await sampler.sample(browser);
			if (!shuttingDown) event('resource-usage', { memoryMB, cpuPercent, cpuTime });
		} catch {
			event('resource-warning', { code: 'RESOURCE_SAMPLE_FAILED' });
		} finally {
			if (!shuttingDown) {
				resourceTimer = setTimeout(() => void sample(), 10000);
				resourceTimer.unref();
			}
		}
	};
	void sample();
}

function send(message: WorkerResponse) {
	if (process.connected) process.send?.(message, () => {});
}

function event(name: string, data: Record<string, unknown> = {}) {
	send({ event: name, data: { ...data, profileId } });
}

function trackPage(page: Page): string {
	const existing = [...pages].find(([, item]) => item === page);
	if (existing) return existing[0];
	const id = randomUUID();
	pages.set(id, page);
	page.once('close', () => {
		pages.delete(id);
		event('page-closed', { pageId: id });
	});
	page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
	page.on('crash', () => event('page-error', { pageId: id, code: 'PAGE_CRASHED' }));
	event('page-created', { pageId: id });
	return id;
}

function requirePage(payload: any): Page {
	const page = payload?.pageId ? pages.get(payload.pageId) : [...pages.values()].find((item) => !item.isClosed());
	if (!page || page.isClosed()) {
		throw Object.assign(new Error('Browser page was not found'), { status: 404, code: 'PAGE_NOT_FOUND' });
	}
	return page;
}

function checkedUrl(value: unknown): string {
	if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid navigation URL');
	const url = new URL(value);
	if (!['http:', 'https:', 'about:'].includes(url.protocol) || (url.protocol === 'about:' && value !== 'about:blank')) {
		throw new Error('Invalid navigation URL');
	}
	return value;
}

function glob(pattern: string): string {
	return '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
}

async function start(options: WorkerStart) {
	if (starting || browser || shuttingDown) throw new Error('Browser worker is already active');
	starting = true;
	profileId = options.profile.id;
	if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileId)) throw new Error('Invalid browser ID');
	const profilePath = path.join(options.dataDir, 'profiles', profileId);
	const downloadsPath = path.join(options.dataDir, 'downloads', profileId);
	const stagingRoot = path.resolve(options.dataDir, 'download-staging');
	const stagingPath = path.join(stagingRoot, profileId);
	if (path.dirname(stagingPath) !== stagingRoot) throw new Error('Invalid download staging directory');
	rmSync(stagingPath, { recursive: true, force: true });
	mkdirSync(profilePath, { recursive: true, mode: 0o700 });
	mkdirSync(downloadsPath, { recursive: true, mode: 0o700 });
	mkdirSync(stagingPath, { recursive: true, mode: 0o700 });
	const enabledScripts = options.scripts.filter(
		(script) => script.enabled && options.profile.userScriptIds.includes(script.id)
	);
	const managedScripts = enabledScripts.filter((script) => script.mode === 'userscript');
	const reconcileManager = managedScripts.length > 0 || hasManagedScripts(options.dataDir, profileId);
	const extensions = reconcileManager
		? await prepareScriptManager({
				dataDir: options.dataDir,
				extensions: options.extensions,
				managerUrl: options.scriptManagerUrl
		  })
		: options.extensions;
	validateExtensions(extensions);
	const extensionList = extensions.join(',');
	browser = await chromium.launchPersistentContext(profilePath, {
		channel: 'chromium',
		headless: true,
		executablePath: options.executablePath,
		viewport: { width: 1365, height: 900 },
		acceptDownloads: true,
		downloadsPath: stagingPath,
		chromiumSandbox: true,
		// This worker owns shutdown. Playwright's signal handlers can force-close
		// Chromium while our browser.close() is still flushing profile storage.
		handleSIGINT: false,
		handleSIGTERM: false,
		handleSIGHUP: false,
		timeout: 30000,
		ignoreDefaultArgs: extensions.length ? ['--disable-extensions'] : undefined,
		args: extensions.length ? [`--disable-extensions-except=${extensionList}`, `--load-extension=${extensionList}`] : []
	});
	if (shuttingDown) {
		await browser.close();
		throw new Error('Browser startup was cancelled');
	}
	browser.setDefaultTimeout(15000);
	browser.setDefaultNavigationTimeout(30000);
	browser.once('close', () => {
		if (!shuttingDown) {
			event('browser-error', { code: 'BROWSER_CLOSED' });
			void dispose(1);
		}
	});
	browser.on('page', (page) => {
		trackPage(page);
		watchDownloads(page, downloadsPath);
	});
	for (const page of browser.pages()) {
		trackPage(page);
		watchDownloads(page, downloadsPath);
	}
	bridge = await installBrowserBridge(browser, options.ocs);
	ocrProxy = await createOCRProxy(options.ocrUrl);
	reportResources();

	const scripts = enabledScripts.filter((script) => script.mode !== 'userscript');
	await browser.exposeBinding('__ocsUserScriptResult', (_source, scriptId: unknown, failed: unknown) => {
		if (typeof scriptId !== 'string' || !scripts.some((script) => script.id === scriptId)) return;
		event('userscript-result', { scriptId, status: failed ? 'error' : 'completed' });
	});
	for (const script of scripts) {
		// Parse only; application code is executed exclusively inside browser pages.
		new Script(script.code);
		const patterns = script.matches.map(glob);
		await browser.addInitScript({
			content: `(() => {
				if (!${JSON.stringify(patterns)}.some(pattern => new RegExp(pattern).test(location.href))) return;
				const execute = () => {
					let failed = false;
					try { (function() {\n${script.code}\n}).call(window); } catch { failed = true; }
					Promise.resolve(window.__ocsUserScriptResult(${JSON.stringify(script.id)}, failed)).catch(() => {});
				};
				if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', execute, { once: true });
				else execute();
			})();`
		});
	}
	if (reconcileManager) {
		await installManagedScripts(browser, {
			scripts: managedScripts,
			dataDir: options.dataDir,
			profileId,
			onEvent: event,
			backgroundUrl: await bridge?.backgroundUrl()
		});
	}
	const firstPage = browser.pages()[0] || (await browser.newPage());
	await firstPage.goto(checkedUrl(options.profile.startUrl), { waitUntil: 'domcontentloaded' });
	starting = false;
	// Slow platform logins do not hold an HTTP startup request open.
	setImmediate(() => void runAutomation(options.profile));
	return { started: true };
}

function watchDownloads(page: Page, directory: string) {
	page.on('download', (download) => {
		if (isManagerPage(page)) return;
		void (async () => {
			const original = path.basename(download.suggestedFilename()).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_');
			const filename = `${randomUUID()}--${original.slice(0, 160) || 'download'}`;
			try {
				await download.saveAs(path.join(directory, filename));
				event('download-completed', { filename });
			} catch {
				event('download-error', { code: 'DOWNLOAD_FAILED' });
			}
		})();
	});
}

async function runAutomation(profile: BrowserProfile) {
	for (const configured of profile.automationScripts) {
		if (!browser || shuttingDown) return;
		const legacy = LegacyScriptMappings.find((mapping) => mapping.names.includes(configured.name));
		const script = AutomationScripts.find((item) => item.name === configured.name) || legacy?.script;
		if (!script) {
			event('automation-result', { name: configured.name, status: 'error', code: 'UNKNOWN_AUTOMATION' });
			continue;
		}
		let page: Page | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let failed = false;
		let failureCode: string | undefined;
		const onError = (...messages: unknown[]) => {
			failed = true;
			const diagnostic = automationDiagnostic(
				messages.find((message) => typeof message === 'string' || message instanceof Error)
			);
			failureCode = diagnostic.code;
			event('automation-diagnostic', { name: script.name, level: 'error', ...diagnostic });
		};
		const onData = () =>
			event('automation-data', {
				name: script.name,
				code: 'AUTOMATION_PROGRESS',
				message: 'Automation reported progress'
			});
		script.on('script-error', onError);
		script.on('script-data', onData);
		event('automation-started', { name: script.name });
		if (script.needOCR && !ocrProxy?.url) event('automation-warning', { name: script.name, code: 'OCR_UNAVAILABLE' });
		try {
			page = await browser.newPage();
			const defaults = Object.fromEntries(
				Object.entries(script.configs as Record<string, Config>).map(([key, value]) => [key, value.value])
			);
			let configs = { ...defaults, ...configured.configs };
			if (legacy) configs = legacy.migrate(configs);
			await Promise.race([
				Promise.resolve(
					script.run(
						page,
						configs,
						ocrProxy?.url
							? {
									ocrApiUrl: ocrProxy.url,
									ocrApiImageKey: 'image',
									detBackgroundKey: 'det_bg',
									detTargetKey: 'det_target'
							  }
							: undefined
					)
				),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Automation timed out')), 45000);
				})
			]);
		} catch (error) {
			onError(error);
			await page?.close().catch(() => {});
		} finally {
			if (timer) clearTimeout(timer);
			script.off('script-error', onError);
			script.off('script-data', onData);
			event('automation-result', {
				name: script.name,
				status: failed ? 'error' : 'completed',
				...(failureCode ? { code: failureCode } : {})
			});
		}
	}
}

async function command(action: BrowserAction, payload: any) {
	if (!browser || shuttingDown) throw new Error('Browser is unavailable');
	if (action === 'screencast-start') {
		const page = requirePage(payload);
		await screencast.start(page, trackPage(page), payload);
		return { completed: true };
	}
	if (action === 'screencast-stop') {
		await screencast.stop();
		return { completed: true };
	}
	if (action === 'screencast-ack') {
		await screencast.acknowledge(payload?.frameId);
		return { completed: true };
	}
	if (action === 'update-ocs') {
		if (!payload?.ocs || typeof payload.ocs !== 'object' || Array.isArray(payload.ocs))
			throw new Error('Invalid OCS configuration');
		bridge?.setOCS(payload.ocs);
		return { completed: true };
	}
	if (action === 'pages') {
		return Promise.all(
			[...pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title().catch(() => '') }))
		);
	}
	if (action === 'new-page') {
		const page = await browser.newPage();
		try {
			if (payload?.url) await page.goto(checkedUrl(payload.url), { waitUntil: 'domcontentloaded' });
			return { id: trackPage(page), url: page.url(), title: await page.title() };
		} catch (error) {
			await page.close().catch(() => {});
			throw error;
		}
	}
	const page = requirePage(payload);
	if (action === 'close-page') {
		await page.close();
		return { completed: true };
	}
	if (action === 'reload') {
		await page.reload({ waitUntil: 'domcontentloaded' });
		return { id: trackPage(page), url: page.url(), title: await page.title() };
	}
	if (action === 'navigate') {
		await page.goto(checkedUrl(payload.url), { waitUntil: 'domcontentloaded' });
		return { id: trackPage(page), url: page.url(), title: await page.title() };
	}
	if (action === 'screenshot') {
		const screenshot = await page.screenshot({ type: 'png', timeout: 15000 });
		return { base64: screenshot.toString('base64'), contentType: 'image/png' };
	}
	if (typeof payload?.selector !== 'string' || !payload.selector || payload.selector.length > 2000) {
		throw Object.assign(new Error('Invalid selector'), { status: 400, code: 'INVALID_SELECTOR' });
	}
	if (action === 'click') await page.locator(payload.selector).click();
	else if (action === 'fill') {
		if (typeof payload.text !== 'string' || payload.text.length > 100000) {
			throw Object.assign(new Error('Invalid field text'), { status: 400, code: 'INVALID_TEXT' });
		}
		await page.locator(payload.selector).fill(payload.text);
	} else if (action === 'press') {
		if (typeof payload.key !== 'string' || !payload.key || payload.key.length > 200) throw new Error('Invalid key');
		await page.locator(payload.selector).press(payload.key);
	} else if (action === 'check') {
		if (payload.checked !== undefined && typeof payload.checked !== 'boolean') throw new Error('Invalid checked');
		await page.locator(payload.selector).setChecked(payload.checked !== false);
	} else if (action === 'select') {
		if (
			!Array.isArray(payload.values) ||
			payload.values.length > 100 ||
			payload.values.some((value: unknown) => typeof value !== 'string' || value.length > 2000)
		)
			throw new Error('Invalid values');
		await page.locator(payload.selector).selectOption(payload.values);
	} else throw new Error('Unsupported action');
	return { completed: true };
}

async function dispose(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	if (resourceTimer) clearTimeout(resourceTimer);
	const timer = setTimeout(() => process.exit(code), 5000);
	try {
		await screencast.stop();
		await Promise.all([browser?.close(), ocrProxy?.close(), bridge?.close()]);
	} catch {
		// Closing an already crashed browser is expected during teardown.
	} finally {
		clearTimeout(timer);
		process.exit(code);
	}
}

process.on('message', (message: WorkerRequest) => {
	if (!message || typeof message.id !== 'string') return;
	if (message.action === 'stop') {
		void dispose();
		return;
	}
	const action = message.action;
	void (async () => {
		try {
			const result = action === 'start' ? await start(message.payload) : await command(action, message.payload);
			send({ id: message.id, ok: true, result });
		} catch (error: any) {
			// Playwright call logs may contain passwords and other form input.
			// Only stable operation summaries cross the worker boundary.
			send({
				id: message.id,
				ok: false,
				error:
					message.action === 'start'
						? 'Browser startup failed; check browser installation and dependencies'
						: 'Browser operation failed',
				code: error?.code === 'PAGE_NOT_FOUND' ? 'PAGE_NOT_FOUND' : 'BROWSER_OPERATION_FAILED',
				status: error?.status === 404 ? 404 : 502
			});
		}
	})();
});

process.on('disconnect', () => void dispose());
process.on('SIGTERM', () => void dispose());
process.on('SIGINT', () => void dispose());
process.on('SIGHUP', () => void dispose());
process.on('uncaughtException', () => void dispose(1));
process.on('unhandledRejection', () => void dispose(1));
