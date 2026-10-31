import { AutomationScripts } from '@ocs-server/common/automation';
import { validateConfigValue } from '@ocs-server/common';
import { BrowserProfile, UserScript } from './types';
import { Script } from 'node:vm';
import { MAX_USER_SCRIPT_BYTES, parseUserScriptMetadata, remoteUrl } from './userscript-source';
import { ApiError } from './api-error';
export { ApiError } from './api-error';

export const bad = (message: string): never => {
	throw new ApiError(400, 'INVALID_REQUEST', message);
};
export const missing = (): never => {
	throw new ApiError(404, 'NOT_FOUND', 'Resource not found');
};
export function object(value: unknown): Record<string, any> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('Expected an object');
	return value;
}
export function fields(body: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(body).some((key) => !allowed.includes(key))) bad('Unknown field');
}
export function text(value: unknown, label: string, max = 200): string {
	if (typeof value !== 'string' || !value.trim() || value.length > max) return bad(`Invalid ${label}`);
	return value;
}
export function url(value: unknown): string {
	const input = text(value, 'url', 4096);
	try {
		const parsed = new URL(input);
		if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
			return bad('Expected http/https URL without credentials');
		return parsed.href;
	} catch {
		return bad('Invalid URL');
	}
}
export const id = (value: string): string => (/^[a-f0-9-]{36}$/.test(value) ? value : missing());

export function browserInput(
	value: unknown,
	previous?: BrowserProfile
): Pick<BrowserProfile, 'name' | 'startUrl' | 'automationScripts' | 'userScriptIds' | 'group' | 'tags' | 'notes'> {
	const body = object(value);
	fields(body, ['name', 'startUrl', 'automationScripts', 'userScriptIds', 'group', 'tags', 'notes']);
	const optionalText = (key: 'group' | 'notes', limit: number) => {
		if (body[key] === undefined) return previous?.[key];
		if (typeof body[key] !== 'string' || body[key].length > limit) return bad(`Invalid ${key}`);
		return body[key] as string;
	};
	const tags = body.tags === undefined ? previous?.tags : body.tags;
	if (
		tags !== undefined &&
		(!Array.isArray(tags) ||
			tags.length > 30 ||
			tags.some((tag: unknown) => typeof tag !== 'string' || !tag.trim() || tag.length > 100))
	)
		bad('Invalid tags');
	const result = {
		name: body.name === undefined && previous ? previous.name : text(body.name, 'name'),
		group: optionalText('group', 500),
		notes: optionalText('notes', 10000),
		tags: tags as string[] | undefined,
		startUrl: body.startUrl === undefined ? previous?.startUrl || 'https://example.com/' : url(body.startUrl),
		automationScripts: body.automationScripts ?? previous?.automationScripts ?? [],
		userScriptIds: body.userScriptIds ?? previous?.userScriptIds ?? []
	};
	if (
		!Array.isArray(result.userScriptIds) ||
		result.userScriptIds.length > 100 ||
		result.userScriptIds.some((s: unknown) => typeof s !== 'string' || !/^[a-f0-9-]{36}$/.test(s))
	)
		bad('Invalid userScriptIds');
	if (!Array.isArray(result.automationScripts) || result.automationScripts.length > 20)
		bad('Invalid automationScripts');
	result.automationScripts = result.automationScripts.map((item: unknown) => {
		const entry = object(item);
		fields(entry, ['name', 'configs']);
		const definition = AutomationScripts.find((s) => s.name === entry.name);
		if (!definition) return bad('Unknown automation script');
		const values = object(entry.configs ?? {});
		fields(values, Object.keys(definition.configs));
		const configs: Record<string, unknown> = {};
		for (const [key, config] of Object.entries(definition.configs)) {
			const old = previous?.automationScripts.find((s) => s.name === entry.name)?.configs[key];
			configs[key] =
				config.type === 'password' && values[key] === '***' ? old ?? config.value : values[key] ?? config.value;
		}
		for (const [key, config] of Object.entries(definition.configs)) {
			if (config.visibleWhen && configs[config.visibleWhen.key] !== config.visibleWhen.value) continue;
			const val = configs[key];
			if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) bad(`Invalid config ${key}`);
			if (config.type === 'switch' && typeof val !== 'boolean') bad(`Invalid config ${key}`);
			if (config.type === 'select' && config.options && !config.options.some((o) => o.value === val))
				bad(`Invalid config ${key}`);
			const error = validateConfigValue({ ...config, value: val });
			if (error) bad(error);
		}
		return { name: definition.name, configs };
	});
	return result;
}

export function publicBrowser(profile: BrowserProfile): BrowserProfile {
	const clone = structuredClone(profile);
	for (const entry of clone.automationScripts) {
		const def = AutomationScripts.find((s) => s.name === entry.name);
		for (const [key, config] of Object.entries(def?.configs || {})) {
			if (config.type === 'password') entry.configs[key] = '***';
		}
	}
	return clone;
}

export function scriptInput(value: unknown, previous?: UserScript): Omit<UserScript, 'id' | 'createdAt' | 'updatedAt'> {
	const body = object(value);
	fields(body, ['name', 'code', 'matches', 'enabled', 'mode', 'sourceUrl', 'updateUrl', 'pinned']);
	if (body.pinned !== undefined && typeof body.pinned !== 'boolean') bad('Invalid pinned state');
	const mode = body.mode ?? previous?.mode ?? 'plain';
	if (mode !== 'plain' && mode !== 'userscript') bad('Invalid script mode');
	const code =
		body.code === undefined && previous
			? previous.code
			: text(body.code, 'code', mode === 'plain' ? 250000 : MAX_USER_SCRIPT_BYTES);
	if (Buffer.byteLength(code, 'utf8') > MAX_USER_SCRIPT_BYTES) bad('Script exceeds the size limit');
	const metadata = mode === 'userscript' ? parseUserScriptMetadata(code) : undefined;
	if (mode === 'userscript' && !metadata) bad('Expected a valid ==UserScript== metadata header');
	if (mode === 'plain') {
		try {
			new Script(code);
		} catch {
			bad('Invalid JavaScript syntax');
		}
	}
	const sourceUrl =
		body.sourceUrl === undefined
			? previous?.sourceUrl
			: body.sourceUrl === '' || body.sourceUrl === null
			? undefined
			: url(body.sourceUrl);
	const explicitUpdate =
		body.updateUrl === undefined
			? undefined
			: body.updateUrl === '' || body.updateUrl === null
			? ''
			: url(body.updateUrl);
	const headerUpdate = metadata?.values.updateURL?.[0] || metadata?.values.updateUrl?.[0];
	const derivedUpdate = headerUpdate && headerUpdate !== 'none' ? remoteUrl(headerUpdate, sourceUrl) : undefined;
	const updateUrl =
		explicitUpdate === undefined
			? (body.code === undefined ? previous?.updateUrl : undefined) ?? derivedUpdate
			: explicitUpdate || undefined;
	const inheritedMatches = body.code === undefined ? previous?.matches : undefined;
	const result = {
		name:
			body.name === undefined ? previous?.name || text(metadata?.values.name?.[0], 'name') : text(body.name, 'name'),
		code,
		matches:
			body.matches ??
			inheritedMatches ??
			(mode === 'userscript'
				? [...(metadata?.values.match || []), ...(metadata?.values.include || [])]
				: previous?.matches) ??
			[],
		enabled: body.enabled ?? previous?.enabled ?? true,
		mode,
		metadata,
		sourceUrl,
		version: metadata?.values.version?.[0],
		pinned: mode === 'userscript' ? body.pinned ?? previous?.pinned : undefined,
		updateUrl
	};
	if (
		typeof result.enabled !== 'boolean' ||
		!Array.isArray(result.matches) ||
		(mode === 'plain' && !result.matches.length) ||
		result.matches.length > 100
	)
		bad('Invalid matches or enabled');
	for (const pattern of result.matches) {
		if (
			typeof pattern !== 'string' ||
			!pattern ||
			pattern.length > 4096 ||
			(mode === 'plain' && !/^https?:\/\/[^\s]+$/.test(pattern))
		)
			bad('matches must contain http/https wildcard URL patterns');
	}
	return result;
}
