import { Router } from 'express';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { AutomationScripts, LegacyScriptMappings } from '@ocs-server/common/automation';
import { ApiError, bad, browserInput, fields, object, scriptInput, text } from './validation';
import type { Store } from './store';
import type { Events } from './events';
import type { Database, RuntimeState, UserScript } from './types';
import { importUserScriptSource } from './userscripts';

export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024;
const PASSWORD_PREFIX = 'v1:scrypt:';
const PASSWORD_PARAMS = { N: 16384, r: 8, p: 1 };
type TransferRuntime = { list(): RuntimeState[] };

function passwordValue(value: unknown): string {
	return text(value, 'export password', 1024);
}

function deriveKey(password: string, salt: Buffer, options = PASSWORD_PARAMS): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key)));
	});
}

/** Matches OCS Desktop's portable v1:scrypt:N:r:p:salt:iv:tag:ciphertext format. */
export async function encryptTransfer(plaintext: string, password: string): Promise<string> {
	passwordValue(password);
	const salt = randomBytes(16);
	const key = await deriveKey(password, salt);
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	return [
		'v1',
		'scrypt',
		PASSWORD_PARAMS.N,
		PASSWORD_PARAMS.r,
		PASSWORD_PARAMS.p,
		salt.toString('base64'),
		iv.toString('base64'),
		cipher.getAuthTag().toString('base64'),
		ciphertext.toString('base64')
	].join(':');
}

function base64(value: string, size?: number): Buffer {
	if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
		return bad('Invalid encrypted export');
	const decoded = Buffer.from(value, 'base64');
	if (size !== undefined && decoded.length !== size) return bad('Invalid encrypted export');
	return decoded;
}

export async function decryptTransfer(payload: string, password: string): Promise<string> {
	const parts = payload.split(':');
	if (parts.length !== 9 || !payload.startsWith(PASSWORD_PREFIX)) return bad('Unsupported encrypted export');
	// Accept the parameters emitted by upstream, without letting input request unbounded scrypt work.
	if (parts[2] !== '16384' || parts[3] !== '8' || parts[4] !== '1')
		return bad('Unsupported export encryption parameters');
	const salt = base64(parts[5], 16);
	const iv = base64(parts[6], 12);
	const tag = base64(parts[7], 16);
	const ciphertext = base64(parts[8]);
	if (typeof password !== 'string' || !password.length || password.length > 1024) bad('Invalid export password');
	try {
		const key = await deriveKey(password, salt);
		const decipher = createDecipheriv('aes-256-gcm', key, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
	} catch {
		throw new ApiError(400, 'EXPORT_DECRYPT_FAILED', 'Incorrect export password or damaged export');
	}
}

function parseJson(content: string): unknown {
	try {
		return JSON.parse(content);
	} catch {
		return bad('Export must contain valid JSON');
	}
}

function date(value: unknown): string {
	if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
		return bad('Invalid export timestamp');
	return new Date(value).toISOString();
}

function recordId(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) return bad('Invalid export ID');
	return value;
}

function jsonValue(value: unknown, depth = 0, budget = { remaining: 100000 }): void {
	if (depth > 64 || --budget.remaining < 0) bad('Export settings are too complex');
	if (value === null || ['string', 'boolean'].includes(typeof value)) return;
	if (typeof value === 'number' && Number.isFinite(value)) return;
	if (Array.isArray(value)) {
		for (const item of value) jsonValue(item, depth + 1, budget);
		return;
	}
	for (const [key, item] of Object.entries(object(value))) {
		if (['__proto__', 'constructor', 'prototype'].includes(key)) bad('Invalid settings key');
		jsonValue(item, depth + 1, budget);
	}
}

/** Reuse management validators and rebuild derived userscript metadata from the original code. */
export function validateTransferDatabase(value: unknown): Database {
	const database = object(value);
	fields(database, ['version', 'browsers', 'userScripts', 'settings']);
	if (
		database.version !== 1 ||
		!Array.isArray(database.browsers) ||
		database.browsers.length > 1000 ||
		!Array.isArray(database.userScripts) ||
		database.userScripts.length > 1000
	)
		return bad('Unsupported export database');
	const userScripts: UserScript[] = database.userScripts.map((value: unknown) => {
		const record = object(value);
		const { id, createdAt, updatedAt, metadata: _metadata, version: _version, ...input } = record;
		return { ...scriptInput(input), id: recordId(id), createdAt: date(createdAt), updatedAt: date(updatedAt) };
	});
	const scriptIds = new Set(userScripts.map((script) => script.id));
	if (scriptIds.size !== userScripts.length) bad('Duplicate user script ID');
	const browsers = database.browsers.map((value: unknown) => {
		const record = object(value);
		const { id, createdAt, updatedAt, ...input } = record;
		const browser = {
			...browserInput(input),
			id: recordId(id),
			createdAt: date(createdAt),
			updatedAt: date(updatedAt)
		};
		if (browser.userScriptIds.some((id) => !scriptIds.has(id))) bad('Unknown user script reference in export');
		return browser;
	});
	if (new Set(browsers.map((browser) => browser.id)).size !== browsers.length) bad('Duplicate browser ID');
	const settings = object(database.settings);
	fields(settings, ['ocs']);
	const ocs = object(settings.ocs);
	jsonValue(ocs);
	return { version: 1, browsers, userScripts, settings: { ocs } };
}

export interface TransferResult {
	database: Database;
	warnings: string[];
}

async function desktopDatabase(render: Record<string, any>): Promise<TransferResult> {
	const root = object(object(render.browser).root);
	if (root.type !== 'root') return bad('Invalid desktop browser tree');
	const entries = render.scripts ?? [];
	if (!Array.isArray(entries) || entries.length > 1000) return bad('Invalid desktop user scripts');
	const warnings = [
		'Desktop runtime paths, browser profiles, cookies, downloads and interface settings are not imported.'
	];
	const now = new Date().toISOString();
	const userScripts: UserScript[] = [];
	// Small batches avoid opening one connection for every exported script at once.
	for (let offset = 0; offset < entries.length; offset += 4) {
		const results = await Promise.all(
			entries.slice(offset, offset + 4).map(async (value: unknown, index: number) => {
				const entry = object(value);
				const source = typeof entry.info?.code_url === 'string' ? entry.info.code_url : entry.url;
				if (entry.isLocalScript || typeof source !== 'string' || !/^https?:\/\//i.test(source)) {
					warnings.push(
						`Desktop script ${
							offset + index + 1
						} uses a local or unsupported source and was skipped; upload its source code separately.`
					);
					return undefined;
				}
				try {
					const input = await importUserScriptSource({ url: source, enabled: entry.enable !== false });
					return { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
				} catch {
					warnings.push(
						`Desktop script ${offset + index + 1} could not be fetched or parsed and was skipped; import it separately.`
					);
					return undefined;
				}
			})
		);
		for (const script of results) if (script) userScripts.push(script);
	}
	const browsers: Database['browsers'] = [];
	const queue = [{ entity: root, depth: 0, group: '' }];
	let visited = 0;
	while (queue.length) {
		const { entity, depth, group } = queue.shift()!;
		if (++visited > 5000 || depth > 64) return bad('Desktop browser tree is too complex');
		if (entity.type === 'root' || entity.type === 'folder') {
			const parent =
				entity.type === 'folder' && typeof entity.name === 'string'
					? [group, entity.name].filter(Boolean).join(' / ').slice(0, 500)
					: group;
			for (const child of Object.values(object(entity.children ?? {})))
				queue.push({ entity: object(child), depth: depth + 1, group: parent });
			continue;
		}
		if (entity.type !== 'browser' || browsers.length >= 1000) return bad('Invalid desktop browser entity');
		const automation = entity.automationScripts ?? [];
		if (!Array.isArray(automation) || automation.length > 20) return bad('Invalid desktop automation scripts');
		const automationScripts = automation.map((value: unknown) => {
			const entry = object(value);
			const legacy = LegacyScriptMappings.find((mapping) => mapping.names.includes(entry.name));
			const definition = AutomationScripts.find((script) => script.name === entry.name) || legacy?.script;
			if (!definition) return bad('Unsupported desktop automation script');
			const configs: Record<string, unknown> = {};
			for (const [key, config] of Object.entries(object(entry.configs ?? {}))) {
				if (key in definition.configs)
					configs[key] = config && typeof config === 'object' && 'value' in config ? config.value : config;
			}
			return { name: definition.name, configs: legacy ? legacy.migrate(configs) : configs };
		});
		const input = browserInput({
			name: entity.name,
			group,
			notes: entity.notes,
			tags: Array.isArray(entity.tags)
				? entity.tags.map((tag: unknown) => (typeof tag === 'string' ? tag : object(tag).name))
				: entity.tags,
			startUrl: 'https://example.com/',
			automationScripts,
			userScriptIds: userScripts.map((script) => script.id)
		});
		browsers.push({ ...input, id: randomUUID(), createdAt: now, updatedAt: now });
	}
	const ocs = render.setting?.ocs === undefined ? {} : object(render.setting.ocs);
	jsonValue(ocs);
	return { database: { version: 1, browsers, userScripts, settings: { ocs } }, warnings };
}

export async function decodeTransfer(content: string, password?: string): Promise<TransferResult> {
	if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > MAX_TRANSFER_BYTES)
		return bad('Invalid export content or export exceeds the size limit');
	const envelope = object(parseJson(content));
	if (envelope.format === 'ocs-server-headless' && envelope.version === 1) {
		fields(envelope, ['format', 'version', 'data']);
		if (typeof envelope.data !== 'string' || !envelope.data.startsWith(PASSWORD_PREFIX))
			return bad('Expected password-protected server export');
		return {
			database: validateTransferDatabase(parseJson(await decryptTransfer(envelope.data, password || ''))),
			warnings: []
		};
	}
	if ('render' in envelope) {
		let render: unknown = envelope.render;
		if (typeof render === 'string') {
			if (!render.startsWith(PASSWORD_PREFIX))
				throw new ApiError(
					400,
					'MACHINE_BOUND_EXPORT',
					'Re-export desktop data as plaintext or with an export password on the original machine'
				);
			render = parseJson(await decryptTransfer(render, password || ''));
		}
		return desktopDatabase(object(render));
	}
	// Explicit native plaintext import also permits disaster recovery from a decoded backup.
	return { database: validateTransferDatabase(envelope), warnings: [] };
}

export function createTransferRouter(store: Store, runtime: TransferRuntime, events: Events): Router {
	const router = Router();
	router.post('/export', (req, res, next) => {
		Promise.resolve()
			.then(async () => {
				const body = object(req.body);
				fields(body, ['password']);
				const data = await encryptTransfer(JSON.stringify(store.read()), passwordValue(body.password));
				const content = JSON.stringify({ format: 'ocs-server-headless', version: 1, data });
				if (Buffer.byteLength(content, 'utf8') > MAX_TRANSFER_BYTES)
					throw new ApiError(413, 'EXPORT_TOO_LARGE', 'Export exceeds the portable data size limit');
				res.attachment('ocs-server-data.ocsdata').type('application/json').send(content);
			})
			.catch(next);
	});
	router.post('/import', (req, res, next) => {
		Promise.resolve()
			.then(async () => {
				const body = object(req.body);
				fields(body, ['content', 'password']);
				if (body.password !== undefined && typeof body.password !== 'string') bad('Invalid export password');
				const result = await decodeTransfer(body.content, body.password);
				// Recheck after asynchronous decryption/downloads; no await separates this check from the atomic commit.
				if (
					runtime
						.list()
						.some((state) => state.pid !== undefined || ['starting', 'running', 'stopping'].includes(state.status))
				)
					throw new ApiError(409, 'BROWSER_BUSY', 'Stop all browsers before importing data');
				store.update((draft) => {
					draft.browsers = result.database.browsers;
					draft.userScripts = result.database.userScripts;
					draft.settings = result.database.settings;
				});
				const summary = {
					browsers: result.database.browsers.length,
					userScripts: result.database.userScripts.length,
					warnings: result.warnings
				};
				events.publish('data.imported', { browsers: summary.browsers, userScripts: summary.userScripts });
				res.json({ data: summary });
			})
			.catch(next);
	});
	return router;
}
