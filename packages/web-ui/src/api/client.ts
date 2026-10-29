import type { ApiFailureCode } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

let bearer = '';
let unauthorized: (() => void) | undefined;

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | ApiFailureCode;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
	}
}

export function apiBase(): string {
	return API_BASE || window.location.origin;
}

export function setBearer(token: string): void {
	bearer = token;
}

export function currentBearer(): string {
	return bearer;
}

export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
	unauthorized = handler;
}

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	body?: unknown;
	signal?: AbortSignal;
	/** Probes pass false so a wrong token does not tear down an existing session. */
	auth?: boolean;
}

async function failure(response: Response): Promise<ApiError> {
	let code = 'HTTP_ERROR';
	let message = `请求失败（HTTP ${response.status}）`;
	try {
		const payload = (await response.json()) as { error?: { code?: string; message?: string } };
		if (payload?.error?.code) code = payload.error.code;
		if (payload?.error?.message) message = payload.error.message;
	} catch {
		// Non-JSON error bodies fall back to the status line.
	}
	return new ApiError(response.status, code, message);
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
	const { method = 'GET', body, signal, auth = true } = options;
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (auth && bearer) headers.Authorization = `Bearer ${bearer}`;
	if (body !== undefined) headers['Content-Type'] = 'application/json';
	let response: Response;
	try {
		response = await fetch(`${API_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
			credentials: 'same-origin'
		});
	} catch (error) {
		if ((error as DOMException | undefined)?.name === 'AbortError') throw error;
		throw new ApiError(0, 'NETWORK_ERROR', '无法连接管理服务');
	}
	if (response.status === 401 && auth) unauthorized?.();
	if (!response.ok) throw await failure(response);
	return response;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const response = await send(path, options);
	if (response.status === 204) return undefined as T;
	const type = response.headers.get('content-type') || '';
	if (!type.includes('application/json')) return (await response.text()) as unknown as T;
	const payload = (await response.json()) as { data?: T };
	return payload.data as T;
}

export interface BlobOptions {
	signal?: AbortSignal;
	onProgress?: (ratio: number, received: number, total: number) => void;
}

/** Authenticated binary fetch. Screenshots and downloads cannot use token-in-URL. */
export async function requestBlob(path: string, options: BlobOptions = {}): Promise<Blob> {
	const headers: Record<string, string> = {};
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	let response: Response;
	try {
		response = await fetch(`${API_BASE}${path}`, { headers, signal: options.signal, credentials: 'same-origin' });
	} catch (error) {
		if ((error as DOMException | undefined)?.name === 'AbortError') throw error;
		throw new ApiError(0, 'NETWORK_ERROR', '无法连接管理服务');
	}
	if (response.status === 401) unauthorized?.();
	if (!response.ok) throw await failure(response);
	const total = Number(response.headers.get('content-length') || 0);
	const type = response.headers.get('content-type') || 'application/octet-stream';
	if (!response.body || !options.onProgress) return response.blob();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.byteLength;
		options.onProgress(total > 0 ? received / total : -1, received, total);
	}
	return new Blob(chunks as unknown as BlobPart[], { type });
}

export function saveBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement('a');
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = 'noopener';
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
	setTimeout(() => URL.revokeObjectURL(url), 4000);
}
