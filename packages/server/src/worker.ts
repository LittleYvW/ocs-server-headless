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

let browser: BrowserContext | undefined;
let starting = false;
let shuttingDown = false;
let profileId = '';
const pages = new Map<string, Page>();

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
	validateExtensions(options.extensions);
	const extensionList = options.extensions.join(',');
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
		ignoreDefaultArgs: options.extensions.length ? ['--disable-extensions'] : undefined,
		args: options.extensions.length
			? [`--disable-extensions-except=${extensionList}`, `--load-extension=${extensionList}`]
			: []
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

	const scripts = options.scripts.filter(
		(script) => script.enabled && options.profile.userScriptIds.includes(script.id)
	);
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
	const firstPage = browser.pages()[0] || (await browser.newPage());
	await firstPage.goto(checkedUrl(options.profile.startUrl), { waitUntil: 'domcontentloaded' });
	starting = false;
	// Slow platform logins do not hold an HTTP startup request open.
	setImmediate(() => void runAutomation(options.profile));
	return { started: true };
}

function watchDownloads(page: Page, directory: string) {
	page.on('download', (download) => {
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
		const onError = () => {
			failed = true;
		};
		script.on('script-error', onError);
		event('automation-started', { name: script.name });
		if (script.needOCR) event('automation-warning', { name: script.name, code: 'OCR_UNAVAILABLE' });
		try {
			page = await browser.newPage();
			const defaults = Object.fromEntries(
				Object.entries(script.configs as Record<string, Config>).map(([key, value]) => [key, value.value])
			);
			let configs = { ...defaults, ...configured.configs };
			if (legacy) configs = legacy.migrate(configs);
			await Promise.race([
				Promise.resolve(script.run(page, configs)),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Automation timed out')), 45000);
				})
			]);
		} catch {
			failed = true;
			await page?.close().catch(() => {});
		} finally {
			if (timer) clearTimeout(timer);
			script.off('script-error', onError);
			event('automation-result', { name: script.name, status: failed ? 'error' : 'completed' });
		}
	}
}

async function command(action: BrowserAction, payload: any) {
	if (!browser || shuttingDown) throw new Error('Browser is unavailable');
	if (action === 'pages') {
		return Promise.all(
			[...pages].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title().catch(() => '') }))
		);
	}
	const page = requirePage(payload);
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
	} else throw new Error('Unsupported action');
	return { completed: true };
}

async function dispose(code = 0) {
	if (shuttingDown) return;
	shuttingDown = true;
	const timer = setTimeout(() => process.exit(code), 5000);
	try {
		await browser?.close();
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
