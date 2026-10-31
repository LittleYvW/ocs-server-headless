import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createOCRProxy, ocrInput, requestOCR } from '../src/ocr';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function fixture(handler: http.RequestListener): Promise<string> {
	const server = http.createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	cleanups.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			})
	);
	return `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/ocr`;
}

describe('configurable OCR adapter', () => {
	it('validates image/detection payloads and enforces image bounds', () => {
		expect(ocrInput({ image: 'YQ==' })).toEqual({ image: 'YQ==' });
		expect(ocrInput({ det_target: 'YQ==', det_bg: 'Yg==' })).toEqual({ det_target: 'YQ==', det_bg: 'Yg==' });
		for (const invalid of [
			{},
			{ image: '' },
			{ det_target: 'YQ==' },
			{ image: 'YQ==', url: 'http://internal/' },
			{ image: 'a'.repeat(2 * 1024 * 1024 + 1) }
		])
			expect(() => ocrInput(invalid)).toThrow('OCR_INVALID_INPUT');
	});
	it('proxies only to the configured endpoint and normalizes recognition results', async () => {
		let seen: unknown;
		const endpoint = await fixture((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (chunk) => chunks.push(chunk));
			req.on('end', () => {
				seen = JSON.parse(Buffer.concat(chunks).toString());
				res.end(JSON.stringify({ canOCR: true, code: '1234', token: 'service-secret' }));
			});
		});
		const proxy = await createOCRProxy(endpoint);
		cleanups.push(proxy.close);
		expect((await fetch(proxy.url!.replace(/\/ocr\/.+/, '/ocr'))).status).toBe(404);
		const response = await fetch(proxy.url!, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ image: 'YQ==' })
		});
		expect(await response.json()).toEqual({ canOCR: true, code: '1234' });
		expect(seen).toEqual({ image: 'YQ==' });
		expect((await createOCRProxy()).url).toBeUndefined();
	});
	it('preserves bounded slider coordinates and sanitizes service failures', async () => {
		const endpoint = await fixture((_req, res) =>
			res.end(JSON.stringify({ canOCR: true, det: { target: [10, 20, 30, 40], extra: 'discarded' } }))
		);
		expect(await requestOCR(endpoint, { det_target: 'YQ==', det_bg: 'YQ==' })).toEqual({
			canOCR: true,
			det: { target: [10, 20, 30, 40] }
		});
		const failed = await fixture((_req, res) => res.end(JSON.stringify({ error: 'private-service-token' })));
		await expect(requestOCR(failed, { image: 'YQ==' })).rejects.toThrow('OCR_SERVICE_FAILED');
	});
	it('bounds service time and response size', async () => {
		const hangs = await fixture(() => {});
		await expect(requestOCR(hangs, { image: 'YQ==' }, 30)).rejects.toMatchObject({ code: 'OCR_TIMEOUT' });
		const large = await fixture((_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
		await expect(requestOCR(large, { image: 'YQ==' })).rejects.toMatchObject({ code: 'OCR_RESPONSE_TOO_LARGE' });
	});
});
