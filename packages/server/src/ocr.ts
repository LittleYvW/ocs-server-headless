import http, { type IncomingMessage } from 'node:http';
import { randomBytes } from 'node:crypto';

const MAX_BODY = 6 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_RESULT = 1024 * 1024;

export class OCRError extends Error {
	constructor(readonly code: string) {
		super(code);
	}
}

export function ocrInput(value: unknown): Record<string, string> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OCRError('OCR_INVALID_INPUT');
	const body = value as Record<string, unknown>;
	if (Object.keys(body).some((key) => !['image', 'det_target', 'det_bg'].includes(key)))
		throw new OCRError('OCR_INVALID_INPUT');
	const image = (key: string): string => {
		const text = body[key];
		if (typeof text !== 'string' || !text.length || text.length > MAX_IMAGE || !/^[A-Za-z0-9+/=\r\n]+$/.test(text))
			throw new OCRError('OCR_INVALID_INPUT');
		return text;
	};
	if (body.image !== undefined && body.det_target === undefined && body.det_bg === undefined)
		return { image: image('image') };
	if (body.image === undefined && body.det_target !== undefined && body.det_bg !== undefined)
		return { det_target: image('det_target'), det_bg: image('det_bg') };
	throw new OCRError('OCR_INVALID_INPUT');
}

/** Keep the external service contract narrow; never return its raw errors or headers. */
export async function requestOCR(
	endpoint: string,
	input: unknown,
	timeoutMs = 15000
): Promise<Record<string, unknown>> {
	const body = ocrInput(input);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
			redirect: 'error'
		});
		if (!response.ok || !response.body) throw new OCRError('OCR_SERVICE_FAILED');
		const chunks: Uint8Array[] = [];
		let size = 0;
		const reader = response.body.getReader();
		while (true) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			size += chunk.byteLength;
			if (size > MAX_RESULT) {
				controller.abort();
				throw new OCRError('OCR_RESPONSE_TOO_LARGE');
			}
			chunks.push(chunk);
		}
		const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!result || typeof result !== 'object' || Array.isArray(result)) throw new OCRError('OCR_INVALID_RESPONSE');
		if (result.error) throw new OCRError('OCR_SERVICE_FAILED');
		if (result.canOCR !== true) return { canOCR: false };
		if ('image' in body && typeof result.code === 'string' && result.code.length <= 10000)
			return { canOCR: true, code: result.code };
		const target = result.det?.target;
		if (
			'det_target' in body &&
			Array.isArray(target) &&
			target.length >= 2 &&
			target.length <= 4 &&
			target.every((value: unknown) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100000)
		)
			return { canOCR: true, det: { target } };
		throw new OCRError('OCR_INVALID_RESPONSE');
	} catch (error) {
		if (error instanceof OCRError) throw error;
		throw new OCRError(controller.signal.aborted ? 'OCR_TIMEOUT' : 'OCR_SERVICE_FAILED');
	} finally {
		clearTimeout(timer);
	}
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY) throw new OCRError('OCR_INPUT_TOO_LARGE');
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new OCRError('OCR_INVALID_INPUT');
	}
}

/** Private per-worker loopback proxy: automation never needs the configured endpoint or API token. */
export async function createOCRProxy(endpoint?: string) {
	if (!endpoint) return { url: undefined, close: async () => {} };
	const pathname = `/ocr/${randomBytes(32).toString('hex')}`;
	const server = http.createServer((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.setHeader('Cache-Control', 'no-store');
		if (req.method !== 'POST' || req.url !== pathname) {
			res.writeHead(404).end('{}');
			return;
		}
		void readBody(req)
			.then((input) => requestOCR(endpoint, input))
			.then((result) => res.end(JSON.stringify(result)))
			.catch((error) => {
				if (res.destroyed) return;
				const code = error instanceof OCRError ? error.code : 'OCR_SERVICE_FAILED';
				res.statusCode = code.startsWith('OCR_INVALID_INPUT') ? 400 : code === 'OCR_INPUT_TOO_LARGE' ? 413 : 502;
				res.end(JSON.stringify({ canOCR: false, error: code }));
			});
	});
	server.requestTimeout = 20000;
	server.headersTimeout = 5000;
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			server.off('error', reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new OCRError('OCR_PROXY_FAILED');
	return {
		url: `http://127.0.0.1:${address.port}${pathname}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	};
}
