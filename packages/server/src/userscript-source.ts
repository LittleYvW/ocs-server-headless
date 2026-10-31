import type { UserScriptMetadata } from './types';
import { ApiError } from './api-error';

export const MAX_USER_SCRIPT_BYTES = 2 * 1024 * 1024;

export function parseUserScriptMetadata(code: string): UserScriptMetadata | undefined {
	const block = code.match(/^\s*\/\/\s*==UserScript==[^\r\n]*\r?\n([\s\S]*?)^\s*\/\/\s*==\/UserScript==[^\r\n]*/m);
	if (!block) return undefined;
	const values: Record<string, string[]> = Object.create(null);
	for (const line of block[1].split(/\r?\n/)) {
		const directive = line.match(/^\s*\/\/\s*@([^\s]+)(?:\s+(.*?))?\s*$/);
		if (directive) (values[directive[1]] ??= []).push(directive[2] || '');
	}
	return { raw: block[0], values };
}

export function remoteUrl(value: string, base?: string): string {
	try {
		const parsed = new URL(value, base);
		if (
			!['http:', 'https:'].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			parsed.href.length > 8192
		)
			throw new Error();
		parsed.hash = '';
		return parsed.href;
	} catch {
		throw new ApiError(400, 'INVALID_SOURCE_URL', 'Expected an HTTP(S) source URL without credentials');
	}
}

export interface RemoteFetchOptions {
	maxBytes?: number;
	timeoutMs?: number;
	maxRedirects?: number;
}

/** Admin-selected source; no cookies, authorization headers or service credentials are forwarded. */
export async function fetchRemoteBytes(
	value: string,
	options: RemoteFetchOptions = {}
): Promise<{ data: Buffer; url: string }> {
	const maxBytes = options.maxBytes ?? MAX_USER_SCRIPT_BYTES;
	const timeoutMs = options.timeoutMs ?? 30000;
	const maxRedirects = options.maxRedirects ?? 5;
	if (
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		!Number.isSafeInteger(maxRedirects) ||
		maxRedirects < 0 ||
		maxRedirects > 20
	)
		throw new Error('Invalid fetch limits');
	let target = remoteUrl(value);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		for (let redirects = 0; ; redirects++) {
			const response = await fetch(target, { redirect: 'manual', signal: controller.signal });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				await response.body?.cancel();
				const location = response.headers.get('location');
				if (!location || redirects >= maxRedirects)
					throw new ApiError(502, 'SOURCE_REDIRECT_FAILED', 'Source redirect limit or invalid redirect');
				target = remoteUrl(location, target);
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new ApiError(502, 'SOURCE_HTTP_ERROR', `Source returned HTTP ${response.status}`);
			}
			const length = response.headers.get('content-length');
			if (length && Number(length) > maxBytes) {
				await response.body?.cancel();
				throw new ApiError(413, 'SOURCE_TOO_LARGE', 'Source exceeds the download size limit');
			}
			const reader = response.body?.getReader();
			const chunks: Buffer[] = [];
			let size = 0;
			if (reader) {
				try {
					while (true) {
						const result = await reader.read();
						if (result.done) break;
						size += result.value.byteLength;
						if (size > maxBytes) throw new ApiError(413, 'SOURCE_TOO_LARGE', 'Source exceeds the download size limit');
						chunks.push(Buffer.from(result.value));
					}
				} finally {
					await reader.cancel().catch(() => {});
				}
			}
			return { data: Buffer.concat(chunks), url: target };
		}
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(
			502,
			controller.signal.aborted ? 'SOURCE_TIMEOUT' : 'SOURCE_FETCH_FAILED',
			controller.signal.aborted ? 'Source download timed out' : 'Source download failed'
		);
	} finally {
		clearTimeout(timer);
	}
}

export async function fetchRemoteText(
	value: string,
	options?: RemoteFetchOptions
): Promise<{ text: string; url: string }> {
	const result = await fetchRemoteBytes(value, options);
	return { text: result.data.toString('utf8'), url: result.url };
}

/** Compare numeric version segments without treating a changed older version as an upgrade. */
export function isNewerVersion(latest: string, current?: string): boolean {
	if (!current) return true;
	if (latest === current) return false;
	const [leftMain, ...leftSuffix] = latest.split('+')[0].split('-');
	const [rightMain, ...rightSuffix] = current.split('+')[0].split('-');
	const left = leftMain.split('.');
	const right = rightMain.split('.');
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const a = left[index] ?? '0';
		const b = right[index] ?? '0';
		if (a === b) continue;
		if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
			if (BigInt(a) === BigInt(b)) continue;
			return BigInt(a) > BigInt(b);
		}
		return a.localeCompare(b, 'en', { numeric: true }) > 0;
	}
	if (!leftSuffix.length || !rightSuffix.length) return !leftSuffix.length && !!rightSuffix.length;
	const leftPre = leftSuffix.join('-').split('.');
	const rightPre = rightSuffix.join('-').split('.');
	for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index++) {
		const a = leftPre[index];
		const b = rightPre[index];
		if (a === b) continue;
		if (a === undefined || b === undefined) return a !== undefined;
		if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
			if (BigInt(a) === BigInt(b)) continue;
			return BigInt(a) > BigInt(b);
		}
		if (/^\d+$/.test(a) !== /^\d+$/.test(b)) return !/^\d+$/.test(a);
		return a.localeCompare(b, 'en', { numeric: true }) > 0;
	}
	return false;
}
