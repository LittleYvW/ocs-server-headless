import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { BrowserContext, Page, Route } from 'playwright-core';
import { createExtensionBridge } from './extension-bridge';

const BRIDGE_PATHS = new Set([
	'/browser',
	'/is-browser-config-sync',
	'/ocs-environment',
	'/ocs-script-actions',
	'/get-actions-key'
]);
const PAGE_PATHS = new Set(['/ocs-environment', '/ocs-script-actions']);
const hash = (value: string) => createHash('sha256').update(value).digest();

export class BridgeError extends Error {
	constructor(readonly code: string, readonly status = 400) {
		super(code);
	}
}

function string(value: unknown, maximum = 2000): string {
	if (typeof value !== 'string' || !value.length || value.length > maximum)
		throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	return value;
}

function number(value: unknown, maximum = 1000000): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > maximum)
		throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	return value;
}

function options(value: unknown, allowed: string[] = ['timeout', 'force']): Record<string, any> {
	if (value === undefined) return { timeout: 15000 };
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !allowed.includes(key))) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	const result: Record<string, any> = { timeout: 15000 };
	if (input.timeout !== undefined) {
		if (typeof input.timeout !== 'number' || input.timeout < 1 || input.timeout > 15000)
			throw new BridgeError('INVALID_ACTION_ARGUMENTS');
		result.timeout = input.timeout;
	}
	if (input.force !== undefined) {
		if (typeof input.force !== 'boolean') throw new BridgeError('INVALID_ACTION_ARGUMENTS');
		result.force = input.force;
	}
	if (input.state !== undefined) {
		if (!['attached', 'detached', 'visible', 'hidden'].includes(input.state as string))
			throw new BridgeError('INVALID_ACTION_ARGUMENTS');
		result.state = input.state;
	}
	return result;
}

/** Literal URL fragments and * globs cover OCS request waits without executing arbitrary regexes. */
function urlMatcher(value: unknown): (request: { url(): string }) => boolean {
	const pattern = string(value, 8192);
	const parts = pattern.split('*');
	if (parts.length > 32) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	return (request) => {
		const url = request.url();
		let from = 0;
		for (const part of parts) {
			const index = url.indexOf(part, from);
			if (index < 0) return false;
			from = index + part.length;
		}
		return true;
	};
}

/** Explicit operations only: no evaluate, arbitrary method lookup, local paths or file upload. */
export async function executeBridgeAction(page: Page, property: unknown, input: unknown): Promise<unknown> {
	if (!Array.isArray(input) || input.length > 4) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
	const args = input;
	switch (property) {
		case 'click':
			return page.click(string(args[0]), options(args[1]));
		case 'check':
			return page.check(string(args[0]), options(args[1]));
		case 'uncheck':
			return page.uncheck(string(args[0]), options(args[1]));
		case 'dblclick':
			return page.dblclick(string(args[0]), options(args[1]));
		case 'tap':
			return page.tap(string(args[0]), options(args[1]));
		case 'hover':
			return page.hover(string(args[0]), options(args[1]));
		case 'focus':
			return page.focus(string(args[0]), options(args[1], ['timeout']));
		case 'fill':
			return page.fill(
				string(args[0]),
				typeof args[1] === 'string' && args[1].length <= 100000 ? args[1] : string(args[1], 100000),
				options(args[2])
			);
		case 'press':
			return page.press(string(args[0]), string(args[1], 200), options(args[2], ['timeout']));
		case 'dragAndDrop':
			return page.dragAndDrop(string(args[0]), string(args[1]), options(args[2]));
		case 'selectOption': {
			const values = args[1];
			if (
				!(typeof values === 'string' && values.length <= 2000) &&
				!(
					Array.isArray(values) &&
					values.length <= 100 &&
					values.every((v) => typeof v === 'string' && v.length <= 2000)
				)
			)
				throw new BridgeError('INVALID_ACTION_ARGUMENTS');
			return page.selectOption(string(args[0]), values, options(args[2]));
		}
		case 'bringToFront':
			await page.bringToFront();
			return null;
		case 'reload':
			await page.reload({ ...options(args[0], ['timeout']), waitUntil: 'domcontentloaded' });
			return null;
		case 'screenshot': {
			const config = args[0];
			if (
				config !== undefined &&
				(!config ||
					typeof config !== 'object' ||
					Array.isArray(config) ||
					Object.keys(config).some((key) => !['fullPage', 'timeout', 'type'].includes(key)) ||
					(config.fullPage !== undefined && typeof config.fullPage !== 'boolean') ||
					(config.type !== undefined && config.type !== 'png'))
			)
				throw new BridgeError('INVALID_ACTION_ARGUMENTS');
			return (
				await page.screenshot({
					type: 'png',
					fullPage: config?.fullPage === true,
					timeout: options({ timeout: config?.timeout ?? 15000 }).timeout
				})
			).toString('base64');
		}
		case 'waitForSelector':
			await page.waitForSelector(string(args[0]), options(args[1], ['timeout', 'state']));
			return null;
		case 'waitForRequest': {
			const req = await page.waitForRequest(urlMatcher(args[0]), options(args[1], ['timeout']));
			const postData = req.postData();
			if (postData && Buffer.byteLength(postData) > 1024 * 1024) throw new BridgeError('RESPONSE_TOO_LARGE');
			return { url: req.url(), method: req.method(), headers: req.headers(), postData };
		}
		case 'waitForResponse': {
			const response = await page.waitForResponse(urlMatcher(args[0]), options(args[1], ['timeout']));
			if (Number(response.headers()['content-length']) > 1024 * 1024) throw new BridgeError('RESPONSE_TOO_LARGE');
			const body = await response.body();
			if (body.length > 1024 * 1024) throw new BridgeError('RESPONSE_TOO_LARGE');
			return {
				url: response.url(),
				status: response.status(),
				headers: response.headers(),
				body: body.toString('utf8')
			};
		}
		case 'keyboard.type':
			await page.keyboard.type(string(args[0], 100000));
			return null;
		case 'keyboard.press':
			await page.keyboard.press(string(args[0], 200));
			return null;
		case 'mouse.wheel':
			await page.mouse.wheel(number(args[0]), number(args[1]));
			return null;
		case 'mouse.click':
			await page.mouse.click(number(args[0]), number(args[1]));
			return null;
		case 'mouse.dblclick':
			await page.mouse.dblclick(number(args[0]), number(args[1]));
			return null;
		case 'mouse.move':
			await page.mouse.move(number(args[0]), number(args[1]));
			return null;
		case 'mouse.down':
			await page.mouse.down();
			return null;
		case 'mouse.up':
			await page.mouse.up();
			return null;
		default:
			throw new BridgeError('UNSUPPORTED_ACTION');
	}
}

function findPage(browser: BrowserContext, target: unknown): Page {
	let url: URL;
	try {
		url = new URL(string(target, 8192));
	} catch {
		throw new BridgeError('INVALID_TARGET_PAGE');
	}
	if (!['http:', 'https:'].includes(url.protocol)) throw new BridgeError('INVALID_TARGET_PAGE');
	const pages = browser.pages().filter((page) => !page.isClosed() && page.url() === url.href);
	if (pages.length !== 1) throw new BridgeError('PAGE_NOT_FOUND', 404);
	return pages[0];
}

export async function installBrowserBridge(browser: BrowserContext, ocs: Record<string, unknown> = {}) {
	const token = randomBytes(32).toString('hex');
	let config = structuredClone(ocs);
	let background: Awaited<ReturnType<typeof createExtensionBridge>> | undefined;
	const matches = (url: URL) =>
		BRIDGE_PATHS.has(url.pathname) &&
		(PAGE_PATHS.has(url.pathname) || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
	await browser.route(matches, async (route: Route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const reply = (body: unknown, status = 200, raw = false) =>
			route.fulfill({
				status,
				contentType: raw ? 'text/plain' : 'application/json',
				headers: {
					'Cache-Control': 'no-store',
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Headers': 'auth-token, content-type',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
				},
				body: status === 204 ? '' : raw ? String(body) : JSON.stringify(body)
			});
		try {
			if (request.method() === 'OPTIONS') {
				await reply(null, 204);
				return;
			}
			if (pathname === '/ocs-script-actions' && request.method() === 'POST') {
				if (!timingSafeEqual(hash((await request.headerValue('auth-token')) || ''), hash(token)))
					throw new BridgeError('UNAUTHORIZED', 401);
				const body = request.postData();
				if (!body || Buffer.byteLength(body) > 256 * 1024) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
				let data: any;
				try {
					data = JSON.parse(body);
				} catch {
					throw new BridgeError('INVALID_ACTION_ARGUMENTS');
				}
				if (!data || typeof data !== 'object' || Array.isArray(data)) throw new BridgeError('INVALID_ACTION_ARGUMENTS');
				const result = await executeBridgeAction(findPage(browser, data.page), data.property, data.args);
				await reply(result ?? null, 200, data.property === 'screenshot');
				return;
			}
			if (request.method() !== 'GET') throw new BridgeError('METHOD_NOT_ALLOWED', 405);
			if (pathname === '/browser') await reply(config.openSync === true ? config.store ?? {} : {});
			else if (pathname === '/is-browser-config-sync') await reply(config.openSync === true, 200, true);
			else if (pathname === '/ocs-environment') await reply({ environment: 'playwright' });
			else if (pathname === '/get-actions-key') await reply(token, 200, true);
			else await reply({ allow: true });
		} catch (error) {
			const known = error instanceof BridgeError;
			await reply({ error: known ? error.code : 'BROWSER_OPERATION_FAILED' }, known ? error.status : 502).catch(
				() => {}
			);
		}
	});
	return {
		backgroundUrl: async () => {
			background ??= await createExtensionBridge(() => config, token);
			return background.url;
		},
		close: async () => {
			await background?.close();
		},
		setOCS: (value: Record<string, unknown>) => {
			config = structuredClone(value);
		}
	};
}
