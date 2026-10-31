import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import type { BrowserContext, Page } from 'playwright-core';
import type { UserScript } from './types';
import { fetchRemoteBytes, parseUserScriptMetadata } from './userscript-source';
import { validateExtensions } from './extensions';

export const DEFAULT_MANAGER_URL =
	'https://github.com/scriptscat/scriptcat/releases/download/v1.5.0/scriptcat-v1.5.0-chrome.zip';
const DEFAULT_MANAGER_SHA256 = '44e5ab9c1cc3ba8ca5200d3485cdc12f5bb1312c174a2781eb8bae2ff59da8d3';

/** Extract into a new, caller-owned directory, with bounded output and no path interpretation. */
export function extractManagerArchive(archive: Uint8Array, directory: string): void {
	let total = 0;
	let count = 0;
	const files = unzipSync(archive, {
		filter(file) {
			if (
				++count > 5000 ||
				!Number.isSafeInteger(file.originalSize) ||
				file.originalSize < 0 ||
				file.originalSize > 32 * 1024 * 1024 ||
				(total += file.originalSize) > 128 * 1024 * 1024
			)
				throw new Error('Script manager archive exceeds extraction limits');
			if (/^[\\/]|[\\:\x00-\x1f]/.test(file.name) || file.name.split('/').some((p) => p === '..' || p === '.'))
				throw new Error('Invalid script manager archive path');
			return true;
		}
	});
	if (!Object.hasOwn(files, 'manifest.json')) throw new Error('Script manager archive has no root manifest');
	for (const [name, bytes] of Object.entries(files)) {
		const target = path.resolve(directory, name);
		if (!target.startsWith(path.resolve(directory) + path.sep)) throw new Error('Invalid archive target');
		if (name.endsWith('/')) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
		else {
			fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
			fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
		}
	}
	validateExtensions([directory]);
}

export async function prepareScriptManager(options: {
	dataDir: string;
	extensions: string[];
	managerUrl?: string;
}): Promise<string[]> {
	for (const directory of options.extensions) {
		validateExtensions([directory]);
		const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
		if (manifest.permissions?.includes('userScripts') && /scriptcat|脚本猫/i.test(manifest.name))
			return options.extensions;
	}
	const url = options.managerUrl || DEFAULT_MANAGER_URL;
	const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
	const parent = path.join(options.dataDir, 'extensions');
	const directory = path.join(parent, 'manager-' + key);
	if (fs.existsSync(path.join(directory, 'manifest.json'))) {
		validateExtensions([directory]);
		return [...options.extensions, directory];
	}
	fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
	const staging = fs.mkdtempSync(path.join(parent, '.manager-'));
	try {
		const { data } = await fetchRemoteBytes(url, { maxBytes: 20 * 1024 * 1024, timeoutMs: 60000 });
		if (url === DEFAULT_MANAGER_URL && createHash('sha256').update(data).digest('hex') !== DEFAULT_MANAGER_SHA256)
			throw new Error('Script manager checksum mismatch');
		extractManagerArchive(data, staging);
		try {
			fs.renameSync(staging, directory);
		} catch (error) {
			if (!fs.existsSync(path.join(directory, 'manifest.json'))) throw error;
		}
		return [...options.extensions, directory];
	} finally {
		// staging is an absolute mkdtemp result below our extension cache.
		if (path.dirname(path.resolve(staging)) === path.resolve(parent))
			fs.rmSync(staging, { recursive: true, force: true });
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const internalPages = new WeakSet<Page>();
export const isManagerPage = (page: Page): boolean => internalPages.has(page);

export function installationCode(script: Pick<UserScript, 'code'>, backgroundUrl?: string): string {
	const metadata = parseUserScriptMetadata(script.code);
	if (!metadata) throw new Error('Invalid standard userscript');
	let header = metadata.raw
		.replace(/^\s*\/\/\s*@(updateURL|downloadURL)\b[^\r\n]*(?:\r?\n)?/gim, '')
		.replace(/\/\/\s*==\/UserScript==/, '// @updateURL none\n// @downloadURL none\n// ==/UserScript==');
	const grants = metadata.values.grant || [];
	if (!backgroundUrl || !grants.some((grant) => grant === 'GM_xmlhttpRequest' || grant === 'GM.xmlHttpRequest'))
		return script.code.replace(metadata.raw, header);
	if (!(metadata.values.connect || []).some((host) => host === '*' || host === '127.0.0.1'))
		header = header.replace(/\/\/\s*==\/UserScript==/, '// @connect 127.0.0.1\n// ==/UserScript==');
	return (
		header +
		`
;((legacy, modern) => {
	const redirect = details => {
		try {
			const url = new URL(details.url);
			if (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname) && url.port === '15319'
				&& ['/browser','/is-browser-config-sync','/get-actions-key'].includes(url.pathname))
				return { ...details, url: ${JSON.stringify(backgroundUrl)} + url.pathname.slice(1) + url.search };
		} catch {}
		return details;
	};
	const request = typeof legacy === 'function' ? details => legacy(redirect(details)) : undefined;
	let gm = modern;
	if (modern && typeof modern.xmlHttpRequest === 'function') {
		const descriptors = Object.getOwnPropertyDescriptors(modern);
		descriptors.xmlHttpRequest = { value: details => modern.xmlHttpRequest(redirect(details)),
			enumerable: true, configurable: false, writable: false };
		gm = Object.create(Object.getPrototypeOf(modern), descriptors);
	}
	(function(GM_xmlhttpRequest, GM) {
${script.code.replace(metadata.raw, '')}
	}).call(this, request, gm);
})(typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : undefined, typeof GM === 'object' ? GM : undefined);
`
	);
}

const scriptHash = (script: UserScript, backgroundUrl?: string) =>
	createHash('sha256').update(installationCode(script, backgroundUrl)).digest('hex');
const scriptIdentity = (script: UserScript) => {
	const metadata = parseUserScriptMetadata(script.code)?.values;
	return JSON.stringify([metadata?.namespace?.[0] || '', metadata?.name?.[0] || script.name]);
};

interface ManagedRecord {
	scriptId: string;
	managerId: string;
	nativeId: string;
	hash: string;
	enabled: boolean;
	identity?: string;
}

function recordFile(dataDir: string, profileId: string): string {
	if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profileId)) throw new Error('Invalid managed script profile');
	return path.join(dataDir, 'script-managers', profileId + '.json');
}

function readRecords(dataDir: string, profileId: string): ManagedRecord[] {
	const filename = recordFile(dataDir, profileId);
	if (!fs.existsSync(filename)) return [];
	const records: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
	if (
		!Array.isArray(records) ||
		records.length > 10000 ||
		records.some(
			(record) =>
				!record ||
				typeof record !== 'object' ||
				!/^[a-zA-Z0-9_-]{1,100}$/.test(record.nativeId) ||
				!/^[a-p]{32}$/.test(record.managerId) ||
				typeof record.scriptId !== 'string' ||
				typeof record.hash !== 'string' ||
				typeof record.enabled !== 'boolean'
		)
	)
		throw new Error('Invalid managed script state');
	return records;
}

export function hasManagedScripts(dataDir: string, profileId: string): boolean {
	return readRecords(dataDir, profileId).length > 0;
}

function saveRecords(dataDir: string, profileId: string, records: ManagedRecord[]): void {
	const filename = recordFile(dataDir, profileId);
	fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
	const staging = filename + '.' + randomUUID() + '.tmp';
	fs.writeFileSync(staging, JSON.stringify(records), { mode: 0o600, flag: 'wx' });
	fs.renameSync(staging, filename);
}

async function managerPage(browser: BrowserContext): Promise<{ page: Page; managerId: string }> {
	for (const worker of browser.serviceWorkers()) {
		const manifest = await worker
			.evaluate(() => {
				const api = (globalThis as any).chrome;
				return api.runtime.getManifest();
			})
			.catch(() => undefined);
		if (
			!manifest?.permissions?.includes('userScripts') ||
			!manifest.options_ui?.page ||
			!/scriptcat|脚本猫/i.test(manifest.name)
		)
			continue;
		const managerId = new URL(worker.url()).host;
		const page = await browser.newPage();
		internalPages.add(page);
		await page.goto(`chrome-extension://${managerId}/${manifest.options_ui.page}`);
		await page
			.getByText(/^(Installed Scripts|已安装脚本)$/)
			.first()
			.waitFor({ state: 'visible' });
		const later = page.getByRole('button', { name: /^(Maybe later|稍后再说|暂时不用)$/ });
		if (await later.count()) await later.click();
		return { page, managerId };
	}
	throw new Error('SCRIPT_MANAGER_UNAVAILABLE');
}

function nativeRow(page: Page, nativeId: string) {
	return page.locator('[data-slot="list-row"]').filter({ has: page.locator(`a[href="#/script/editor/${nativeId}"]`) });
}

async function nativeIds(page: Page): Promise<Set<string>> {
	await page
		.getByText(/^(Installed Scripts|已安装脚本)$/)
		.first()
		.waitFor({ state: 'visible' });
	return new Set(
		await page
			.locator('a[href^="#/script/editor/"]')
			.evaluateAll((links) =>
				links
					.map((link) => link.getAttribute('href')?.match(/^#\/script\/editor\/([a-zA-Z0-9_-]{1,100})$/)?.[1])
					.filter((value): value is string => !!value)
			)
	);
}

async function setNativeEnabled(page: Page, nativeId: string, enabled: boolean): Promise<void> {
	const row = nativeRow(page, nativeId);
	await row.waitFor({ state: 'visible', timeout: 15000 });
	const toggle = row.getByRole('switch');
	await toggle.waitFor({ state: 'visible' });
	if (((await toggle.getAttribute('aria-checked')) === 'true') !== enabled) await toggle.click();
	const deadline = Date.now() + 5000;
	while (((await toggle.getAttribute('aria-checked')) === 'true') !== enabled) {
		if (Date.now() > deadline) throw new Error('SCRIPT_STATE_NOT_CONFIRMED');
		await pause(50);
	}
}

async function waitForRegistration(
	browser: BrowserContext,
	managerId: string,
	nativeId: string,
	enabled: boolean
): Promise<void> {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		for (const worker of browser.serviceWorkers().filter((item) => new URL(item.url()).host === managerId)) {
			const ids: string[] | undefined = await worker
				.evaluate(async () => {
					const api = (globalThis as any).chrome;
					return (await api.userScripts.getScripts()).map((script: { id: string }) => script.id);
				})
				.catch(() => undefined);
			if (ids && ids.includes(nativeId) === enabled) return;
		}
		await pause(50);
	}
	throw new Error('SCRIPT_REGISTRATION_NOT_CONFIRMED');
}

/** Recover a prior interrupted install only when its displayed identity is unambiguous. */
async function findNativeScript(page: Page, script: UserScript): Promise<string> {
	const expected = parseUserScriptMetadata(script.code)?.values;
	const name = expected?.name?.[0] || script.name;
	const links = page.getByRole('link', { name, exact: true });
	await links.first().waitFor({ state: 'visible', timeout: 15000 });
	for (let i = 0; i < (await links.count()); i++) {
		const href = await links.nth(i).getAttribute('href');
		const nativeId = href?.match(/^#\/script\/editor\/([a-zA-Z0-9_-]{1,100})$/)?.[1];
		if (!nativeId) continue;
		if ((await links.count()) === 1) return nativeId;
	}
	throw new Error('SCRIPT_IDENTITY_NOT_CONFIRMED');
}

async function enableUserScripts(browser: BrowserContext): Promise<void> {
	const settings = await browser.newPage();
	try {
		await settings.goto('chrome://extensions/');
		const developer = settings.locator('#devMode');
		await developer.waitFor({ state: 'visible' });
		if (!(await developer.evaluate((element: any) => element.checked === true))) await developer.click();
		if (!browser.serviceWorkers().length) await browser.waitForEvent('serviceworker', { timeout: 15000 });
		for (const worker of [...browser.serviceWorkers()]) {
			const extensionId = new URL(worker.url()).host;
			await settings.goto('chrome://extensions/?id=' + extensionId);
			const toggle = settings.locator('#allow-user-scripts cr-toggle');
			await settings.locator('extensions-detail-view').waitFor({ state: 'visible' });
			if ((await toggle.count()) && !(await toggle.evaluate((element: any) => element.checked === true))) {
				await toggle.click();
				// Chromium's permission guard requires reloading the extension after this change.
				const enabled = settings.locator('extensions-detail-view #enableToggle');
				await enabled.click();
				await settings.waitForFunction(() => {
					const manager = document.querySelector('extensions-manager')?.shadowRoot;
					const detail = manager?.querySelector('extensions-detail-view')?.shadowRoot;
					return (detail?.querySelector('#enableToggle') as any)?.checked === false;
				});
				const restarted = browser.waitForEvent('serviceworker', {
					predicate: (next) => next.url() === worker.url(),
					timeout: 15000
				});
				await enabled.click();
				await restarted;
			}
		}
	} finally {
		await settings.close().catch(() => {});
	}
}

async function installOne(browser: BrowserContext, source: string, managerId: string): Promise<void> {
	const before = new Set(browser.pages());
	const trigger = await browser.newPage();
	internalPages.add(trigger);
	let installation: Page | undefined;
	try {
		void trigger.goto(source, { timeout: 5000 }).catch(() => {});
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			installation = browser
				.pages()
				.find(
					(page) =>
						!before.has(page) &&
						page.url().startsWith('chrome-extension://' + managerId + '/') &&
						/install/i.test(page.url())
				);
			if (installation) break;
			await pause(100);
		}
		if (!installation) throw new Error('SCRIPT_INSTALL_PAGE_MISSING');
		internalPages.add(installation);
		const install = installation
			.getByRole('button', { name: /^(安装|重新安装|更新|Install|Reinstall|Update)(?:脚本| Script)?$/i })
			.first();
		await install.waitFor({ state: 'visible', timeout: 15000 });
		await install.click();
		const until = Date.now() + 15000;
		while (Date.now() < until) {
			if (installation.isClosed()) return;
			if (await installation.getByText(/安装成功|更新成功|installed successfully|installation successful/i).count())
				return;
			if ((await install.count()) === 0) return;
			await pause(150);
		}
		throw new Error('SCRIPT_INSTALL_NOT_CONFIRMED');
	} finally {
		await installation?.close().catch(() => {});
		await trigger.close().catch(() => {});
	}
}

/** Only this short-lived loopback server can serve the selected scripts; no disk paths or admin token. */
export async function installManagedScripts(
	browser: BrowserContext,
	options: {
		scripts: UserScript[];
		dataDir: string;
		profileId: string;
		onEvent: (name: string, data: Record<string, unknown>) => void;
		backgroundUrl?: string;
	}
): Promise<void> {
	const secret = randomUUID();
	const records = readRecords(options.dataDir, options.profileId);
	const sources = new Map(options.scripts.map((script) => ['/' + secret + '/' + script.id + '.user.js', script]));
	const server = http.createServer((req, res) => {
		const script = req.method === 'GET' ? sources.get(req.url || '') : undefined;
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		if (!script) {
			res.writeHead(404).end();
			return;
		}
		res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
		res.end(installationCode(script, options.backgroundUrl));
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(0, '127.0.0.1', resolve);
		});
		await enableUserScripts(browser);
		const manager = await managerPage(browser);
		const port = (server.address() as import('node:net').AddressInfo).port;
		try {
			for (const record of records.filter((item) => item.managerId === manager.managerId)) {
				const desired = options.scripts.some(
					(script) => script.id === record.scriptId && scriptHash(script, options.backgroundUrl) === record.hash
				);
				if (!desired && (await nativeRow(manager.page, record.nativeId).count())) {
					await setNativeEnabled(manager.page, record.nativeId, false);
					await waitForRegistration(browser, manager.managerId, record.nativeId, false);
					record.enabled = false;
					saveRecords(options.dataDir, options.profileId, records);
					options.onEvent('userscript-disabled', { scriptId: record.scriptId });
				}
			}
			for (const [pathname, script] of sources) {
				options.onEvent('userscript-install-started', { scriptId: script.id });
				try {
					const hash = scriptHash(script, options.backgroundUrl);
					let record = records.find(
						(item) => item.managerId === manager.managerId && item.scriptId === script.id && item.hash === hash
					);
					if (record && !(await nativeRow(manager.page, record.nativeId).count())) record = undefined;
					if (!record) {
						const prior = records.find(
							(item) => item.managerId === manager.managerId && item.identity === scriptIdentity(script)
						);
						const beforeIds = await nativeIds(manager.page);
						await installOne(browser, 'http://127.0.0.1:' + port + pathname, manager.managerId);
						await manager.page.reload();
						const afterIds = await nativeIds(manager.page);
						const added = [...afterIds].filter((id) => !beforeIds.has(id));
						const nativeId =
							prior && afterIds.has(prior.nativeId)
								? prior.nativeId
								: added.length === 1
								? added[0]
								: await findNativeScript(manager.page, script);
						record = records.find((item) => item.managerId === manager.managerId && item.nativeId === nativeId);
						if (record) Object.assign(record, { scriptId: script.id, hash, identity: scriptIdentity(script) });
						else {
							record = {
								scriptId: script.id,
								managerId: manager.managerId,
								nativeId,
								hash,
								enabled: false,
								identity: scriptIdentity(script)
							};
							records.push(record);
						}
					}
					await setNativeEnabled(manager.page, record.nativeId, true);
					await waitForRegistration(browser, manager.managerId, record.nativeId, true);
					record.enabled = true;
					saveRecords(options.dataDir, options.profileId, records);
					options.onEvent('userscript-install-result', {
						scriptId: script.id,
						status: 'completed',
						version: script.version
					});
				} catch (error) {
					options.onEvent('userscript-install-result', {
						scriptId: script.id,
						status: 'error',
						code: 'SCRIPT_INSTALL_FAILED'
					});
					throw new Error('Standard userscript installation failed', { cause: error });
				}
			}
		} finally {
			await manager.page.close().catch(() => {});
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const page of browser.pages()) {
			try {
				const url = new URL(page.url());
				if (url.hostname === 'docs.scriptcat.org' && /\/(install_comple|open-dev|changelog)(\/|$)/.test(url.pathname))
					await page.close().catch(() => {});
			} catch {
				/* An about:blank page has no URL hostname. */
			}
		}
	}
}
