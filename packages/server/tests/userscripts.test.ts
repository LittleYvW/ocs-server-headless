import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { Store } from '../src/store';
import { Events } from '../src/events';
import { ApiError } from '../src/validation';
import { createUserScriptRouter } from '../src/userscripts';
import { fetchRemoteBytes, isNewerVersion, parseUserScriptMetadata } from '../src/userscript-source';

let directory: string;
let store: Store;
let server: Server;
let fixture: Server;
let base: string;
let origin: string;
let version: string;
let invalidSource: boolean;
const code = (value = version) =>
	`// ==UserScript==\n// @name Source script\n// @version ${value}\n// @match *://example.com/*\n// @include /https?:\\/\\/example\\.org\\//\n// @exclude https://example.com/private/*\n// @require https://example.org/library.js\n// @grant GM_getValue\n// @run-at document-start\n// @updateURL ${origin}/meta.js\n// @custom one\n// @custom two\n// ==/UserScript==\nwindow.sourceVersion = ${JSON.stringify(
		value
	)};`;

async function listen(value: Server): Promise<string> {
	await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(value.address() as AddressInfo).port}`;
}
function request(route: string, method = 'GET', body?: unknown) {
	return fetch(base + route, {
		method,
		headers: { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}
async function json(route: string, method = 'GET', body?: unknown) {
	const response = await request(route, method, body);
	return { status: response.status, ...((await response.json()) as any) };
}
beforeEach(async () => {
	version = '1.0';
	invalidSource = false;
	fixture = createServer((req, res) => {
		if (req.url === '/stall') return;
		if (req.url === '/redirect') {
			res.writeHead(302, { Location: '/script.user.js' }).end();
			return;
		}
		if (req.url === '/unsafe-redirect') {
			res.writeHead(302, { Location: 'file:///etc/passwd' }).end();
			return;
		}
		if (req.url === '/loop') {
			res.writeHead(302, { Location: '/loop' }).end();
			return;
		}
		if (req.url === '/large') {
			res.write('x'.repeat(300));
			res.end('x'.repeat(300));
			return;
		}
		if (req.url === '/error') {
			res.writeHead(503).end('unavailable');
			return;
		}
		const target = new URL(req.url || '/', 'http://localhost');
		if (target.pathname === '/versions/1.0/code.user.js') {
			res.end(code('1.0'));
			return;
		}
		if (target.pathname === '/meta.js' || target.pathname === '/script.user.js') {
			res.end(invalidSource ? '<html>upstream failed</html>' : code(target.searchParams.get('version') || version));
			return;
		}
		res.writeHead(404).end();
	});
	origin = await listen(fixture);
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-userscript-test-'));
	const config = loadConfig({ OCS_DATA_DIR: directory, OCS_PORT: '0', OCS_AUTH_TOKEN: 'test-token-'.repeat(8) });
	store = new Store(directory, config.keyFile);
	const app = express();
	app.use(express.json({ limit: '3mb' }));
	app.use('/scripts', createUserScriptRouter(config, store, new Events(directory)));
	app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
		const known = error instanceof ApiError;
		res.status(known ? error.status : 500).json({ error: { code: known ? error.code : 'INTERNAL_ERROR' } });
	});
	server = createServer(app);
	base = await listen(server);
});
afterEach(async () => {
	for (const service of [server, fixture]) {
		service.closeAllConnections();
		await new Promise<void>((resolve, reject) => service.close((error) => (error ? reject(error) : resolve())));
	}
	store.close();
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('userscript management', () => {
	it('pins historical source paths without relying on a version query parameter', async () => {
		const source = origin + '/versions/1.0/code.user.js';
		const created = await json('/scripts/import', 'POST', { url: source, pinned: true });
		const resource = '/scripts/' + created.data.id;
		version = '2.0';
		expect((await json(resource + '/check-update', 'POST')).data).toMatchObject({
			available: false,
			latestVersion: '1.0'
		});
		expect((await json(resource + '/update', 'POST')).data).toMatchObject({ version: '1.0', pinned: true });
		await json(resource, 'PATCH', { pinned: false });
		expect((await json(resource + '/check-update', 'POST')).data.available).toBe(true);
	});
	it('retains a selected version despite generic metadata update URLs, unless the administrator overrides the update source', async () => {
		const pinned = origin + '/script.user.js?version=1.0';
		const created = await json('/scripts/import', 'POST', { url: pinned });
		const resource = '/scripts/' + created.data.id;
		version = '2.0';
		expect((await json(resource + '/check-update', 'POST')).data).toMatchObject({
			available: false,
			latestVersion: '1.0',
			updateUrl: pinned
		});
		expect((await json(resource + '/update', 'POST')).data).toMatchObject({ version: '1.0', sourceUrl: pinned });
		await json(resource, 'PATCH', { updateUrl: origin + '/script.user.js' });
		expect((await json(resource + '/check-update', 'POST')).data.available).toBe(true);
		expect((await json(resource + '/update', 'POST')).data.version).toBe('2.0');
	});
	it('preserves old ordinary-JS CRUD, references and raw-code download', async () => {
		const created = await json('/scripts', 'POST', {
			name: 'ordinary',
			code: 'window.ready = true;',
			matches: ['https://example.com/*']
		});
		expect(created.status).toBe(201);
		expect(created.data.mode).toBe('plain');
		const resource = '/scripts/' + created.data.id;
		const raw = await request(resource + '/code');
		expect(raw.headers.get('content-type')).toContain('application/javascript');
		expect(raw.headers.get('content-disposition')).toContain('.user.js');
		expect(await raw.text()).toBe(created.data.code);
		expect((await json(resource, 'PATCH', { enabled: false })).data.enabled).toBe(false);
		expect((await json(resource + '/check-update', 'POST')).status).toBe(409);
		expect((await request(resource, 'DELETE')).status).toBe(204);
		expect((await request(resource)).status).toBe(404);
	});
	it('imports source text, preserving directives and the complete raw header without Node parsing', async () => {
		const source = code() + '\nreturn;';
		const created = await json('/scripts/import', 'POST', { code: source, enabled: false });
		expect(created.status).toBe(201);
		expect(created.data).toMatchObject({ name: 'Source script', mode: 'userscript', enabled: false, version: '1.0' });
		expect(created.data.matches).toEqual(['*://example.com/*', '/https?:\\/\\/example\\.org\\//']);
		expect(created.data.metadata.values).toMatchObject({
			grant: ['GM_getValue'],
			'run-at': ['document-start'],
			require: ['https://example.org/library.js'],
			custom: ['one', 'two']
		});
		expect(source.startsWith(created.data.metadata.raw)).toBe(true);
		expect(created.data.code).toBe(source);
		expect((await json('/scripts/import', 'POST', { code: source, url: origin + '/script.user.js' })).status).toBe(400);
		expect((await json('/scripts/import', 'POST', { code: 'window.noHeader = true;' })).status).toBe(400);
		expect((await json('/scripts/import', 'POST', { path: '/etc/passwd' })).status).toBe(400);
	});
	it('downloads a redirect source, checks versions without mutation and explicitly applies updates', async () => {
		const created = await json('/scripts/import', 'POST', { url: origin + '/redirect' });
		expect(created.status).toBe(201);
		expect(created.data.sourceUrl).toBe(origin + '/redirect');
		const resource = '/scripts/' + created.data.id;
		version = '2.0';
		const checked = await json(resource + '/check-update', 'POST');
		expect(checked.data).toMatchObject({ available: true, currentVersion: '1.0', latestVersion: '2.0' });
		expect(store.read().userScripts[0].version).toBe('1.0');
		await json(resource, 'PATCH', { name: 'My name', enabled: false });
		const updated = await json(resource + '/update', 'POST');
		expect(updated.status).toBe(200);
		expect(updated.data).toMatchObject({
			name: 'My name',
			enabled: false,
			version: '2.0',
			sourceUrl: origin + '/redirect'
		});
		expect((await json(resource + '/check-update', 'POST')).data.available).toBe(false);
		invalidSource = true;
		expect((await json(resource + '/update', 'POST')).status).toBe(502);
		expect(store.read().userScripts[0].code).toBe(updated.data.code);
	});
	it('rejects unsafe URLs, plain-JS syntax errors and unexpected input while supporting standard match syntax', async () => {
		expect((await json('/scripts/import', 'POST', { url: 'file:///etc/passwd' })).status).toBe(400);
		expect(
			(await json('/scripts/import', 'POST', { url: 'https://user:password@example.com/script.user.js' })).status
		).toBe(400);
		expect((await json('/scripts/import', 'POST', { url: origin + '/unsafe-redirect' })).status).toBe(400);
		expect(
			(await json('/scripts', 'POST', { name: 'broken', code: 'function {', matches: ['https://example.com/*'] }))
				.status
		).toBe(400);
		expect(
			(await json('/scripts', 'POST', { name: 'plain', code: 'void 0;', matches: ['*://example.com/*'] })).status
		).toBe(400);
		expect((await json('/scripts', 'POST', { mode: 'userscript', code: code() })).status).toBe(201);
	});
});

describe('bounded source retrieval and metadata', () => {
	it('bounds streamed bytes, total timeout, redirect count, and reports failed source status', async () => {
		await expect(fetchRemoteBytes(origin + '/large', { maxBytes: 100 })).rejects.toMatchObject({
			status: 413,
			code: 'SOURCE_TOO_LARGE'
		});
		await expect(fetchRemoteBytes(origin + '/stall', { timeoutMs: 50 })).rejects.toMatchObject({
			code: 'SOURCE_TIMEOUT'
		});
		await expect(fetchRemoteBytes(origin + '/loop', { maxRedirects: 1 })).rejects.toMatchObject({
			code: 'SOURCE_REDIRECT_FAILED'
		});
		await expect(fetchRemoteBytes(origin + '/error')).rejects.toMatchObject({ code: 'SOURCE_HTTP_ERROR' });
		const downloaded = await fetchRemoteBytes(origin + '/redirect');
		expect(downloaded.url).toBe(origin + '/script.user.js');
		expect(downloaded.data.toString()).toBe(code());
	});
	it('keeps repeated and unknown directives safely, and compares versions without downgrades', () => {
		const metadata = parseUserScriptMetadata(
			'// ==UserScript==\n// @name Example\n// @__proto__ safe\n// @grant GM_getValue\n// @grant GM_setValue\n// ==/UserScript=='
		);
		expect(metadata?.values.grant).toEqual(['GM_getValue', 'GM_setValue']);
		expect(metadata?.values.__proto__).toEqual(['safe']);
		expect(isNewerVersion('1.10', '1.9')).toBe(true);
		expect(isNewerVersion('2026.1.30', '2026.01.29')).toBe(true);
		expect(isNewerVersion('1.0', '2.0')).toBe(false);
		expect(isNewerVersion('2.0-beta', '2.0')).toBe(false);
		expect(isNewerVersion('2.0', '2.0-beta')).toBe(true);
		expect(isNewerVersion('2.0+build2', '2.0+build1')).toBe(false);
	});
});
