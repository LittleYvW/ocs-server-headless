import { describe, it, expect, vi } from 'vitest';
import { createCipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '../src/types';
import type { Store } from '../src/store';
import type { Events } from '../src/events';
import {
	createTransferRouter,
	decodeTransfer,
	decryptTransfer,
	encryptTransfer,
	validateTransferDatabase
} from '../src/transfer';

function database(): Database {
	const scriptId = randomUUID();
	const now = new Date().toISOString();
	return {
		version: 1,
		userScripts: [
			{
				id: scriptId,
				name: 'fixture',
				code: 'document.title="ready";',
				matches: ['https://example.com/*'],
				enabled: true,
				createdAt: now,
				updatedAt: now
			}
		],
		browsers: [
			{
				id: randomUUID(),
				name: 'account',
				startUrl: 'https://example.com/',
				userScriptIds: [scriptId],
				automationScripts: [
					{ name: '职教云-自动账号密码登录', configs: { username: 'person', password: 'private-login-password' } }
				],
				createdAt: now,
				updatedAt: now
			}
		],
		settings: { ocs: { openSync: true, store: { setting: 'value' } } }
	};
}

function desktopCipher(plaintext: string, password: string) {
	const salt = randomBytes(16);
	const iv = randomBytes(12);
	const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [
		'v1',
		'scrypt',
		16384,
		8,
		1,
		salt.toString('base64'),
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		data.toString('base64')
	].join(':');
}

describe('portable data transfer', () => {
	it('roundtrips complete credentials through a password-protected, machine-independent export', async () => {
		const data = database();
		Object.assign(data.browsers[0], { group: '课程 / 第一组', tags: ['fixture'], notes: 'Portable notes' });
		const encrypted = await encryptTransfer(JSON.stringify(data), 'portable-passphrase');
		expect(encrypted).not.toContain('private-login-password');
		const imported = await decodeTransfer(
			JSON.stringify({ format: 'ocs-server-headless', version: 1, data: encrypted }),
			'portable-passphrase'
		);
		expect(imported.database.browsers[0].automationScripts[0].configs.password).toBe('private-login-password');
		expect(imported.database.browsers[0]).toMatchObject({
			group: '课程 / 第一组',
			tags: ['fixture'],
			notes: 'Portable notes'
		});
		expect(imported.database.browsers[0].userScriptIds).toEqual([imported.database.userScripts[0].id]);
		expect(imported.warnings).toEqual([]);
		await expect(decryptTransfer(encrypted, 'wrong')).rejects.toMatchObject({ code: 'EXPORT_DECRYPT_FAILED' });
		await expect(encryptTransfer('secret', '')).rejects.toMatchObject({ status: 400 });
	});

	it('imports real desktop password framing and flattens legacy automation configs without trusting paths', async () => {
		const render = {
			browser: {
				root: {
					type: 'root',
					children: {
						folder: {
							type: 'folder',
							name: 'Imported group',
							children: {
								account: {
									type: 'browser',
									uid: 'desktop-old-id',
									name: 'Migrated account',
									notes: 'Legacy notes',
									tags: [{ name: 'Legacy tag', color: 'blue' }],
									cachePath: '/private/foreign/path',
									automationScripts: [
										{
											name: '超星-手机密码登录',
											configs: { phone: { value: '13800000000' }, password: { value: 'legacy-secret' } }
										}
									]
								}
							}
						}
					}
				}
			},
			scripts: [{ isLocalScript: true, url: '/etc/passwd', enable: true }],
			setting: { ocs: { openSync: true, store: { test: 1 } }, launchOptions: { executablePath: '/bin/sh' } }
		};
		const imported = await decodeTransfer(
			JSON.stringify({ render: desktopCipher(JSON.stringify(render), 'desktop-password') }),
			'desktop-password'
		);
		expect(imported.database.browsers).toHaveLength(1);
		expect(imported.database.browsers[0]).toMatchObject({
			group: 'Imported group',
			notes: 'Legacy notes',
			tags: ['Legacy tag']
		});
		expect(imported.database.browsers[0]).not.toHaveProperty('cachePath');
		expect(imported.database.browsers[0].automationScripts[0]).toMatchObject({
			name: '超星-自动登录',
			configs: { loginType: 'phone', phone: '13800000000', password: 'legacy-secret' }
		});
		expect(imported.database.userScripts).toEqual([]);
		expect(imported.warnings.some((warning) => warning.includes('local'))).toBe(true);
		expect(imported.database.settings.ocs).toEqual(render.setting.ocs);
		await expect(decodeTransfer(JSON.stringify({ render: 'machine-bound:encrypted:content' }))).rejects.toMatchObject({
			code: 'MACHINE_BOUND_EXPORT'
		});
	});

	it('rejects dangling references, duplicate IDs, runtime paths and malicious encryption parameters', async () => {
		const dangling = database();
		dangling.browsers[0].userScriptIds = [randomUUID()];
		expect(() => validateTransferDatabase(dangling)).toThrow('Unknown user script reference');
		const duplicate = database();
		duplicate.userScripts.push(structuredClone(duplicate.userScripts[0]));
		expect(() => validateTransferDatabase(duplicate)).toThrow('Duplicate user script ID');
		const paths = database();
		(paths.browsers[0] as any).executablePath = '/bin/sh';
		expect(() => validateTransferDatabase(paths)).toThrow('Unknown field');
		const cipher = desktopCipher('data', 'password');
		await expect(decryptTransfer(cipher.replace(':16384:', ':1073741824:'), 'password')).rejects.toThrow('parameters');
	});

	it('fetches desktop network scripts and preserves their metadata through a native roundtrip', async () => {
		const code =
			'// ==UserScript==\n// @name Imported fixture\n// @version 2.4.1\n// @match *://example.com/*\n// @grant GM_getValue\n// ==/UserScript==\nconsole.log("fixture");';
		const fixture = http.createServer((_req, res) => {
			res.setHeader('Content-Type', 'application/javascript');
			res.end(code);
		});
		fixture.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => fixture.once('listening', resolve));
		try {
			const source = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/fixture.user.js`;
			const imported = await decodeTransfer(
				JSON.stringify({
					render: {
						browser: {
							root: {
								type: 'root',
								children: { instance: { type: 'browser', name: 'network', automationScripts: [] } }
							}
						},
						scripts: [{ enable: true, isInternetLinkScript: true, url: source }],
						setting: { ocs: {} }
					}
				})
			);
			expect(imported.database.userScripts[0]).toMatchObject({
				mode: 'userscript',
				version: '2.4.1',
				sourceUrl: source,
				metadata: { values: { grant: ['GM_getValue'] } }
			});
			expect(imported.database.browsers[0].userScriptIds).toEqual([imported.database.userScripts[0].id]);
			const normalized = validateTransferDatabase(imported.database);
			expect(normalized.userScripts[0]).toEqual(imported.database.userScripts[0]);
		} finally {
			await new Promise<void>((resolve) => {
				fixture.close(() => resolve());
				fixture.closeAllConnections();
			});
		}
	});

	it('does not mutate data while any browser is active, and export requires a password', async () => {
		let current = database();
		let status: 'running' | 'stopped' | 'error' = 'running';
		let workerPid: number | undefined;
		const publish = vi.fn();
		const store = {
			read: () => structuredClone(current),
			update: (change: (draft: Database) => void) => {
				const draft = structuredClone(current);
				change(draft);
				current = draft;
			}
		} as Store;
		const app = express();
		app.use(express.json());
		app.use(
			createTransferRouter(store, { list: () => [{ id: current.browsers[0].id, status, pid: workerPid }] }, {
				publish
			} as unknown as Events)
		);
		app.use((error: any, _req: any, res: any, _next: any) =>
			res.status(error.status || 500).json({ error: { code: error.code } })
		);
		const server = app.listen(0, '127.0.0.1');
		await new Promise<void>((resolve) => server.once('listening', resolve));
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const post = (path: string, body: unknown) =>
			fetch(base + path, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
		try {
			expect((await post('/export', {})).status).toBe(400);
			const incoming = database();
			incoming.browsers[0].name = 'replacement';
			expect((await post('/import', { content: JSON.stringify(incoming) })).status).toBe(409);
			expect(current.browsers[0].name).toBe('account');
			status = 'error';
			workerPid = 123;
			expect((await post('/import', { content: JSON.stringify(incoming) })).status).toBe(409);
			status = 'stopped';
			workerPid = undefined;
			expect((await post('/import', { content: JSON.stringify(incoming) })).status).toBe(200);
			expect(current.browsers[0].name).toBe('replacement');
			expect(publish).toHaveBeenCalledWith('data.imported', { browsers: 1, userScripts: 1 });
			const response = await post('/export', { password: 'protected' });
			expect(response.status).toBe(200);
			expect(await response.text()).not.toContain('private-login-password');
		} finally {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	});
});
