import { AutomationScripts } from '@ocs-server/common/automation';
import { validateConfigValue } from '@ocs-server/common';
import { BrowserProfile, UserScript } from './types';

export class ApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
	}
}
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
): Pick<BrowserProfile, 'name' | 'startUrl' | 'automationScripts' | 'userScriptIds'> {
	const body = object(value);
	fields(body, ['name', 'startUrl', 'automationScripts', 'userScriptIds']);
	const result = {
		name: body.name === undefined && previous ? previous.name : text(body.name, 'name'),
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

export function scriptInput(
	value: unknown,
	previous?: UserScript
): Pick<UserScript, 'name' | 'code' | 'matches' | 'enabled'> {
	const body = object(value);
	fields(body, ['name', 'code', 'matches', 'enabled']);
	const result = {
		name: body.name === undefined && previous ? previous.name : text(body.name, 'name'),
		code: body.code === undefined && previous ? previous.code : text(body.code, 'code', 250000),
		matches: body.matches ?? previous?.matches ?? [],
		enabled: body.enabled ?? previous?.enabled ?? true
	};
	if (
		typeof result.enabled !== 'boolean' ||
		!Array.isArray(result.matches) ||
		!result.matches.length ||
		result.matches.length > 100
	)
		bad('Invalid matches or enabled');
	for (const pattern of result.matches) {
		if (typeof pattern !== 'string' || pattern.length > 4096 || !/^https?:\/\/[^\s]+$/.test(pattern))
			bad('matches must contain http/https wildcard URL patterns');
	}
	return result;
}
