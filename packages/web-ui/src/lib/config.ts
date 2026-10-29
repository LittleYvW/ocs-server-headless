import type { ConfigDefinition } from '@/api/types';

const DOMAIN_LIKE_RE =
	/^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9]([\w-]*[a-z0-9])?(\.[a-z0-9]([\w-]*[a-z0-9])?)+)(:\d+)?([/?#].*)?$/i;

/** Mirrors packages/common/src/utils/url.ts so form input matches backend behaviour. */
export function normalizeUrl(input: unknown): string {
	let value = String(input ?? '').trim();
	value = value.replace(/^["'<\s]+/, '').replace(/["'>\s]+$/, '');
	if (!value) return value;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return value;
	if (value.startsWith('//')) return 'https:' + value;
	if (DOMAIN_LIKE_RE.test(value)) {
		return 'https://' + value;
	}
	return value;
}

/**
 * Mirrors packages/common/src/utils/config.ts. Server-side validation remains
 * authoritative; this only prevents obviously invalid submissions.
 */
export function validateConfig(config: ConfigDefinition, value: unknown): string | undefined {
	const empty = value === undefined || value === null || String(value).trim() === '';
	if (empty) return config.required ? `请输入${config.label}` : undefined;
	switch (config.type) {
		case 'url': {
			try {
				const parsed = new URL(normalizeUrl(value));
				if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
					return `${config.label}格式不正确，需为 http/https 链接`;
				}
			} catch {
				return `${config.label}格式不正确，需为 http/https 链接`;
			}
			break;
		}
		case 'number': {
			const number = Number(value);
			if (Number.isNaN(number)) return `${config.label}必须为数字`;
			if (config.min !== undefined && number < config.min) return `${config.label}不能小于 ${config.min}`;
			if (config.max !== undefined && number > config.max) return `${config.label}不能大于 ${config.max}`;
			break;
		}
		case 'switch':
			if (typeof value !== 'boolean') return `${config.label}必须为开关值`;
			break;
		case 'select':
			if (config.options && !config.options.some((option) => option.value === value)) {
				return `${config.label}不在可选范围内`;
			}
			break;
		default: {
			const length = String(value).trim().length;
			if (config.min !== undefined && length < config.min) return `${config.label}长度不能少于 ${config.min} 位`;
			if (config.max !== undefined && length > config.max) return `${config.label}长度不能超过 ${config.max} 位`;
			break;
		}
	}
	if (config.pattern) {
		try {
			if (!new RegExp(config.pattern).test(String(value).trim())) {
				return config.patternMessage || `${config.label}格式不正确`;
			}
		} catch {
			// Invalid declared patterns are ignored, matching the shared validator.
		}
	}
	return undefined;
}

export function isVisible(config: ConfigDefinition, values: Record<string, unknown>): boolean {
	return !config.visibleWhen || values[config.visibleWhen.key] === config.visibleWhen.value;
}

export function splitMatches(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

export function isHttpPattern(pattern: string): boolean {
	return /^https?:\/\/\S+$/.test(pattern);
}

export function validateMatches(patterns: string[]): string | undefined {
	if (!patterns.length) return '至少填写一条匹配地址。';
	if (patterns.length > 100) return '最多 100 条匹配地址。';
	const invalid = patterns.find((pattern) => pattern.length > 4096 || !isHttpPattern(pattern));
	return invalid ? `匹配地址需为 http/https：${invalid}` : undefined;
}
