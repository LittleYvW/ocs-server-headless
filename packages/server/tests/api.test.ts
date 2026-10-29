import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startServer } from '../src/index';
import { loadConfig } from '../src/config';
import { Store } from '../src/store';

let dir: string;
let service: Awaited<ReturnType<typeof startServer>>;
let base: string;
const token = 'test-token-'.repeat(8);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
async function request(route: string, method = 'GET', body?: unknown, extra = {}) {
	return fetch(base + route, {
		method,
		headers: { ...headers, ...extra },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}
beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-api-test-'));
	service = await startServer(loadConfig({ OCS_DATA_DIR: dir, OCS_AUTH_TOKEN: token, OCS_PORT: '0' }));
	base = `http://127.0.0.1:${(service.server.address() as import('net').AddressInfo).port}`;
});
afterEach(async () => {
	await service.close();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('management API', () => {
	it('exposes OCR requirements without blocking profile creation', async () => {
		const response = await request('/api/v1/automation-scripts');
		expect(response.status).toBe(200);
		const definitions = ((await response.json()) as any).data;
		expect(definitions.find((item: any) => item.name === '通用-新建页面').needOCR).toBe(false);
		expect(definitions.filter((item: any) => item.needOCR)).toHaveLength(5);
		const login = definitions.find((item: any) => item.name === '职教云-自动账号密码登录');
		expect(login.needOCR).toBe(true);
		const created = await request('/api/v1/browsers', 'POST', {
			name: 'OCR optional',
			automationScripts: [{ name: login.name, configs: { username: 'person', password: 'secret' } }]
		});
		expect(created.status).toBe(201);
	});
	it('requires auth, restricts origins and has no old RPC/token routes', async () => {
		expect((await fetch(base + '/healthz')).status).toBe(200);
		expect((await fetch(base + '/api/v1/browsers')).status).toBe(401);
		expect((await request('/api/v1/browsers', 'GET', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401);
		expect((await request('/api/v1/browsers', 'GET', undefined, { Origin: 'https://untrusted.example' })).status).toBe(
			403
		);
		expect((await fetch(base + '/get-actions-key')).status).toBe(404);
		const preflight = await fetch(base + '/api/v1/system', {
			method: 'OPTIONS',
			headers: { Origin: base }
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get('access-control-allow-headers')).toContain('Last-Event-ID');
	});
	it('persists profile credentials encrypted and redacts API responses', async () => {
		const created = await request('/api/v1/browsers', 'POST', {
			name: 'account',
			automationScripts: [
				{ name: '职教云-自动账号密码登录', configs: { username: 'person', password: 'unique-private-password' } }
			]
		});
		expect(created.status).toBe(201);
		const profile = ((await created.json()) as any).data;
		expect(profile.automationScripts[0].configs.password).toBe('***');
		expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).not.toContain('unique-private-password');
		const patch = await request('/api/v1/browsers/' + profile.id, 'PATCH', {
			automationScripts: profile.automationScripts
		});
		expect(patch.status).toBe(200);
		expect(service.store.read().browsers[0].automationScripts[0].configs.password).toBe('unique-private-password');
		await service.close();
		const restored = new Store(dir, path.join(dir, 'encryption.key'));
		expect(restored.read().browsers[0].name).toBe('account');
		restored.close();
	});
	it('validates conditional automation configs and blocks executable paths', async () => {
		expect((await request('/api/v1/browsers', 'POST', { name: 'x', executablePath: '/bin/sh' })).status).toBe(400);
		expect((await request('/api/v1/browsers', 'POST', { name: 'x', startUrl: 'file:///etc/passwd' })).status).toBe(400);
		expect(
			(
				await request('/api/v1/browsers', 'POST', {
					name: 'x',
					automationScripts: [
						{ name: '超星-自动登录', configs: { loginType: 'phone', phone: '13800000000', password: 'secret' } }
					]
				})
			).status
		).toBe(201);
	});
	it('keeps script references consistent and handles stopped browsers', async () => {
		const script = (
			(await (
				await request('/api/v1/user-scripts', 'POST', {
					name: 'plain',
					code: 'document.title="ready"',
					matches: ['https://example.com/*']
				})
			).json()) as any
		).data;
		const profile = (
			(await (
				await request('/api/v1/browsers', 'POST', { name: 'instance', userScriptIds: [script.id] })
			).json()) as any
		).data;
		expect((await request('/api/v1/user-scripts/' + script.id, 'DELETE')).status).toBe(409);
		expect((await request(`/api/v1/browsers/${profile.id}/pages`)).status).toBe(409);
		expect((await request('/api/v1/browsers/' + profile.id, 'DELETE')).status).toBe(204);
		expect((await request('/api/v1/user-scripts/' + script.id, 'DELETE')).status).toBe(204);
	});
	it('rejects malformed JSON, unsafe download paths, and missing resources', async () => {
		const response = await fetch(base + '/api/v1/browsers', { method: 'POST', headers, body: '{' });
		expect(response.status).toBe(400);
		expect((await request('/api/v1/browsers/not-an-id')).status).toBe(404);
		const p = ((await (await request('/api/v1/browsers', 'POST', { name: 'p' })).json()) as any).data;
		expect((await request(`/api/v1/browsers/${p.id}/downloads/..%5cadmin.token`)).status).toBe(404);
	});
});

describe('event stream', () => {
	it('rejects unauthenticated subscriptions without registering a listener', async () => {
		const response = await fetch(base + '/api/v1/events');
		expect(response.status).toBe(401);
		expect(((await response.json()) as any).error.code).toBe('UNAUTHORIZED');
		expect(service.events.listenerCount('event')).toBe(0);
	});

	it('delivers authenticated events and removes the listener after client cancellation', async () => {
		const response = await fetch(base + '/api/v1/events', { headers, signal: AbortSignal.timeout(3000) });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const reader = response.body!.getReader();
		try {
			expect(service.events.listenerCount('event')).toBe(1);
			service.events.publish('test.delivery', { marker: 'stream-regression-marker' });
			let received = '';
			const decoder = new TextDecoder();
			while (!received.includes('stream-regression-marker')) {
				const chunk = await reader.read();
				expect(chunk.done).toBe(false);
				received += decoder.decode(chunk.value, { stream: true });
			}
			expect(received).toContain('event: test.delivery\n');
			expect(received).toContain('"marker":"stream-regression-marker"');
		} finally {
			await reader.cancel();
		}
		await expect.poll(() => service.events.listenerCount('event')).toBe(0);
	});

	it('survives backpressure during a large replay and leaves no subscription behind', async () => {
		for (let index = 0; index < 500; index++) {
			service.events.publish('test.replay', { index, payload: 'x'.repeat(4096) });
		}
		const response = await fetch(base + '/api/v1/events', {
			headers: { ...headers, 'Last-Event-ID': '1' },
			signal: AbortSignal.timeout(3000)
		});
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();
		let bytes = 0;
		try {
			while (bytes < 32768) {
				const chunk = await reader.read();
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
			}
			expect(bytes).toBeGreaterThan(0);
		} finally {
			await reader.cancel();
		}
		await expect.poll(() => service.events.listenerCount('event')).toBe(0);
		expect((await fetch(base + '/healthz')).status).toBe(200);
	});
});

describe('console hosting', () => {
	it('serves the built shell with its own CSP and does not shadow API 404s', async () => {
		const web = path.join(dir, 'web');
		fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
		fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><div id="app"></div>');
		fs.writeFileSync(path.join(web, 'assets', 'app-a1b2.js'), 'console.log("console");');
		await service.close();
		service = await startServer(
			loadConfig({ OCS_DATA_DIR: dir, OCS_AUTH_TOKEN: token, OCS_PORT: '0', OCS_WEB_DIR: web })
		);
		base = `http://127.0.0.1:${(service.server.address() as import('net').AddressInfo).port}`;

		const page = await fetch(base + '/');
		expect(page.status).toBe(200);
		expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
		expect(page.headers.get('cache-control')).toBe('no-store');
		expect(await page.text()).toContain('id="app"');

		const asset = await fetch(base + '/assets/app-a1b2.js');
		expect(asset.status).toBe(200);
		expect(asset.headers.get('cache-control')).toContain('immutable');
		expect(asset.headers.get('content-security-policy')).toContain("script-src 'self'");

		// Hash routing needs no SPA rewrite; unknown paths stay JSON 404s.
		expect((await request('/api/v1/unknown-route')).status).toBe(404);
		expect((await fetch(base + '/get-actions-key')).status).toBe(404);
	});
});

describe('durability', () => {
	it('refuses to replace a missing encryption key for an existing database', async () => {
		await service.close();
		const filename = path.join(dir, 'state.json');
		const original = fs.readFileSync(filename);
		const keyFile = path.join(dir, 'encryption.key');
		fs.unlinkSync(keyFile);
		expect(() => new Store(dir, keyFile)).toThrow('Encryption key missing');
		expect(fs.existsSync(keyFile)).toBe(false);
		expect(fs.readFileSync(filename)).toEqual(original);
	});
	it('rejects duplicate data owners', () => {
		expect(() => new Store(dir, path.join(dir, 'encryption.key'))).toThrow('already in use');
	});
	it('fails closed on state corruption without replacing it', async () => {
		await service.close();
		const original = fs.readFileSync(path.join(dir, 'state.json'));
		fs.writeFileSync(path.join(dir, 'state.json'), 'broken');
		expect(() => new Store(dir, path.join(dir, 'encryption.key'))).toThrow();
		expect(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).toBe('broken');
		fs.writeFileSync(path.join(dir, 'state.json'), original);
		// A persistent Linux flock inode is expected; failed startup must release ownership.
		const restored = new Store(dir, path.join(dir, 'encryption.key'));
		restored.close();
	});
});
