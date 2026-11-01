import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';
import { startServer } from '../src/index';

let dir: string;
let service: Awaited<ReturnType<typeof startServer>> | undefined;
const token = 'question-bank-admin-'.repeat(3);
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-bank-config-'));
});
afterEach(async () => {
	await service?.close();
	service = undefined;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('optional question bank integration', () => {
	it('keeps Node-only deployments available and reports the disabled query feature', async () => {
		service = await startServer(loadConfig({ OCS_DATA_DIR: dir, OCS_PORT: '0', OCS_AUTH_TOKEN: token }));
		const base = 'http://127.0.0.1:' + (service.server.address() as import('net').AddressInfo).port;
		const status = await fetch(base + '/api/v1/question-bank/status', {
			headers: { Authorization: 'Bearer ' + token }
		});
		expect(await status.json()).toEqual({ data: { configured: false, available: false } });
		const query = await fetch(base + '/question-bank/query?title=fixture', {
			headers: { Authorization: 'Bearer ' + 'a'.repeat(64) }
		});
		expect(query.status).toBe(503);
		expect(await query.json()).toMatchObject({ code: 0, data: null, error: { code: 'QUESTION_BANK_DISABLED' } });
		expect((await fetch(base + '/healthz')).status).toBe(200);
	});
	it('requires a fixed upstream origin and an explicit absolute internal credential file', () => {
		const env = { OCS_DATA_DIR: dir, OCS_AUTH_TOKEN: token };
		for (const url of [
			'file:///etc/passwd',
			'http://user:secret@host:3002',
			'http://host:3002/admin',
			'http://host:3002/?token=private'
		]) {
			expect(() =>
				loadConfig({
					...env,
					OCS_QUESTION_BANK_URL: url,
					OCS_QUESTION_BANK_TOKEN_FILE: path.join(dir, 'private.token')
				})
			).toThrow();
		}
		expect(() => loadConfig({ ...env, OCS_QUESTION_BANK_TOKEN_FILE: path.join(dir, 'private.token') })).toThrow();
		expect(() => loadConfig({ ...env, OCS_QUESTION_BANK_URL: 'http://127.0.0.1:3002' })).toThrow();
	});
});
