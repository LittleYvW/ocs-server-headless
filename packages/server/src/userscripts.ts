import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config';
import type { Store } from './store';
import type { Events } from './events';
import type { UserScript } from './types';
import { ApiError, bad, fields, id, missing, object, scriptInput, text } from './validation';
import { fetchRemoteText, isNewerVersion, parseUserScriptMetadata, remoteUrl } from './userscript-source';

export { fetchRemoteBytes, fetchRemoteText, parseUserScriptMetadata } from './userscript-source';

export interface UserScriptImport {
	url?: string;
	code?: string;
	name?: string;
	enabled?: boolean;
	pinned?: boolean;
}

/** Shared with legacy-data import; a file upload supplies text, never a server filesystem path. */
export async function importUserScriptSource(
	input: UserScriptImport
): Promise<Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'>> {
	if ((input.url === undefined) === (input.code === undefined)) bad('Provide exactly one of code or url');
	const result = input.url === undefined ? undefined : await fetchRemoteText(text(input.url, 'url', 8192));
	return scriptInput({
		mode: 'userscript',
		code: result?.text ?? input.code,
		sourceUrl: input.url === undefined ? undefined : remoteUrl(input.url),
		name: input.name,
		enabled: input.enabled,
		pinned: input.pinned
	});
}

function customUpdateSource(script: UserScript): string | undefined {
	if (!script.updateUrl) return undefined;
	const header = script.metadata?.values.updateURL?.[0] || script.metadata?.values.updateUrl?.[0];
	const automatic = header && header !== 'none' ? remoteUrl(header, script.sourceUrl) : undefined;
	return script.updateUrl !== automatic ? script.updateUrl : undefined;
}

function pinnedSource(script: UserScript): string | undefined {
	if (!script.sourceUrl || customUpdateSource(script)) return undefined;
	const source = new URL(remoteUrl(script.sourceUrl));
	return script.pinned ?? !!source.searchParams.get('version') ? source.href : undefined;
}

function updateSource(script: UserScript): string {
	if (script.mode !== 'userscript')
		throw new ApiError(409, 'NOT_A_USER_SCRIPT', 'Only standard userscripts support source updates');
	const header = script.metadata?.values.updateURL?.[0] || script.metadata?.values.updateUrl?.[0];
	if (header === 'none' && !script.updateUrl)
		throw new ApiError(409, 'UPDATES_DISABLED', 'This userscript disables source update checks');
	const source =
		pinnedSource(script) ||
		script.updateUrl ||
		header ||
		script.sourceUrl ||
		script.metadata?.values.downloadURL?.[0] ||
		script.metadata?.values.downloadUrl?.[0];
	if (!source) throw new ApiError(409, 'SOURCE_UNAVAILABLE', 'This script has no update source');
	return remoteUrl(source, script.sourceUrl);
}

function downloadSource(script: UserScript): string {
	const pinned = pinnedSource(script);
	if (pinned) return pinned;
	const custom = customUpdateSource(script);
	if (custom) {
		const source = new URL(remoteUrl(custom, script.sourceUrl));
		source.pathname = source.pathname.replace(/\.meta\.js$/, '.user.js');
		return source.href;
	}
	const source =
		script.metadata?.values.downloadURL?.[0] || script.metadata?.values.downloadUrl?.[0] || script.sourceUrl;
	if (source && source !== 'none') return remoteUrl(source, script.sourceUrl);
	const update = updateSource(script);
	const parsed = new URL(update);
	parsed.pathname = parsed.pathname.replace(/\.meta\.js$/, '.user.js');
	return parsed.href;
}

export function createUserScriptRouter(_config: ServerConfig, store: Store, events: Events): Router {
	const router = Router();
	const route = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
		Promise.resolve()
			.then(() => fn(req, res))
			.catch(next);
	};
	const data = (res: Response, value: unknown, status = 200) => res.status(status).json({ data: value });
	const read = (value: string) => store.read().userScripts.find((script) => script.id === id(value)) || missing();
	const view = (script: UserScript) => ({ ...script, mode: script.mode || 'plain' });
	const add = (input: Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'>) => {
		const now = new Date().toISOString();
		const item: UserScript = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
		store.update((db) => {
			if (db.userScripts.length >= 1000) throw new ApiError(409, 'LIMIT_REACHED', 'Script limit reached');
			db.userScripts.push(item);
		});
		events.publish('userscript.created', { scriptId: item.id });
		return item;
	};
	router.get(
		'/',
		route((_req, res) => data(res, store.read().userScripts.map(view)))
	);
	router.post(
		'/',
		route((req, res) => data(res, add(scriptInput(req.body)), 201))
	);
	router.post(
		'/import',
		route(async (req, res) => {
			const body = object(req.body);
			fields(body, ['url', 'code', 'name', 'enabled', 'pinned']);
			return data(res, add(await importUserScriptSource(body)), 201);
		})
	);
	router.get(
		'/:id/code',
		route((req, res) => {
			const script = read(req.params.id);
			const filename = script.name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').slice(0, 100) || 'script';
			res
				.attachment(filename + '.user.js')
				.type('application/javascript')
				.send(script.code);
		})
	);
	router.post(
		'/:id/check-update',
		route(async (req, res) => {
			if (req.body !== undefined) fields(object(req.body), []);
			const script = read(req.params.id);
			const source = updateSource(script);
			const downloaded = await fetchRemoteText(source);
			const metadata = parseUserScriptMetadata(downloaded.text);
			if (!metadata)
				throw new ApiError(502, 'INVALID_SOURCE_SCRIPT', 'Update source did not contain userscript metadata');
			const latestVersion = metadata.values.version?.[0] || null;
			return data(res, {
				available: latestVersion ? isNewerVersion(latestVersion, script.version) : false,
				currentVersion: script.version || null,
				latestVersion,
				updateUrl: source
			});
		})
	);
	router.post(
		'/:id/update',
		route(async (req, res) => {
			if (req.body !== undefined) fields(object(req.body), []);
			const previous = read(req.params.id);
			updateSource(previous);
			const downloaded = await fetchRemoteText(downloadSource(previous));
			const newMetadata = parseUserScriptMetadata(downloaded.text);
			if (!newMetadata)
				throw new ApiError(502, 'INVALID_SOURCE_SCRIPT', 'Update source did not contain userscript metadata');
			const oldName = previous.metadata?.values.name?.[0];
			const input = scriptInput({
				mode: 'userscript',
				code: downloaded.text,
				name: previous.name === oldName ? newMetadata.values.name?.[0] || previous.name : previous.name,
				enabled: previous.enabled,
				pinned: previous.pinned,
				sourceUrl: previous.sourceUrl || downloaded.url,
				updateUrl:
					customUpdateSource(previous) ||
					(newMetadata.values.updateURL?.[0] || newMetadata.values.updateUrl?.[0] ? undefined : previous.updateUrl)
			});
			const item: UserScript = { ...previous, ...input, updatedAt: new Date().toISOString() };
			store.update((db) => {
				const index = db.userScripts.findIndex((script) => script.id === previous.id);
				if (index === -1) missing();
				if (JSON.stringify(db.userScripts[index]) !== JSON.stringify(previous))
					throw new ApiError(409, 'SCRIPT_CHANGED', 'Script changed during download; retry the update');
				db.userScripts[index] = item;
			});
			events.publish('userscript.updated', { scriptId: item.id });
			return data(res, view(item));
		})
	);
	router.get(
		'/:id',
		route((req, res) => data(res, view(read(req.params.id))))
	);
	router.patch(
		'/:id',
		route((req, res) => {
			const previous = read(req.params.id);
			const item = { ...previous, ...scriptInput(req.body, previous), updatedAt: new Date().toISOString() };
			store.update((db) => {
				db.userScripts[db.userScripts.findIndex((script) => script.id === previous.id)] = item;
			});
			events.publish('userscript.updated', { scriptId: item.id });
			return data(res, view(item));
		})
	);
	router.delete(
		'/:id',
		route((req, res) => {
			const script = read(req.params.id);
			store.update((db) => {
				if (db.browsers.some((profile) => profile.userScriptIds.includes(script.id)))
					throw new ApiError(409, 'SCRIPT_IN_USE', 'Remove browser references before deleting the script');
				db.userScripts = db.userScripts.filter((item) => item.id !== script.id);
			});
			events.publish('userscript.deleted', { scriptId: script.id });
			res.sendStatus(204);
		})
	);
	return router;
}
