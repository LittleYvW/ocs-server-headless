import { describe, expect, it, vi } from 'vitest';
import { executeBridgeAction, installBrowserBridge } from '../src/browser-bridge';
import { automationDiagnostic } from '../src/automation-diagnostics';

async function bridge(ocs: Record<string, unknown> = {}) {
	let handler: any;
	let matches: any;
	const fill = vi.fn();
	const page = { url: () => 'https://course.test/lesson?id=1', isClosed: () => false, fill };
	await installBrowserBridge(
		{
			route: async (matcher: any, callback: any) => {
				matches = matcher;
				handler = callback;
			},
			pages: () => [page]
		} as any,
		ocs
	);
	const request = async (path: string, method = 'GET', body?: unknown, token = '') => {
		let response: any;
		await handler({
			request: () => ({
				url: () => `http://localhost:15319${path}`,
				method: () => method,
				headerValue: async () => token,
				postData: () => (body === undefined ? null : JSON.stringify(body))
			}),
			fulfill: async (value: any) => {
				response = value;
			}
		});
		return response;
	};
	return { request, matches, fill, page };
}

describe('per-browser OCS bridge', () => {
	it('applies a configuration snapshot only when synchronization is enabled', async () => {
		const source = { openSync: true, store: { answerer: 'fixture' } };
		const one = await bridge(source);
		source.store.answerer = 'changed';
		expect(JSON.parse((await one.request('/browser')).body)).toEqual({ answerer: 'fixture' });
		expect((await one.request('/is-browser-config-sync')).body).toBe('true');
		const disabled = await bridge({ openSync: false, store: { secret: 'hidden' } });
		expect(JSON.parse((await disabled.request('/browser')).body)).toEqual({});
		expect(JSON.parse((await one.request('/ocs-environment')).body)).toEqual({ environment: 'playwright' });
		expect(one.matches(new URL('https://course.test/browser'))).toBe(false);
		expect(one.matches(new URL('https://course.test/lesson?next=/ocs-environment'))).toBe(false);
		expect(one.matches(new URL('https://course.test/ocs-environment?cache=1'))).toBe(true);
	});
	it('uses independent instance tokens and rejects arbitrary method paths and local file operations', async () => {
		const first = await bridge();
		const second = await bridge();
		const token = (await first.request('/get-actions-key')).body;
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect((await second.request('/get-actions-key')).body).not.toBe(token);
		const body = { page: first.page.url(), property: 'fill', args: ['#input', 'private-value'] };
		expect((await second.request('/ocs-script-actions', 'POST', body, token)).status).toBe(401);
		expect((await first.request('/ocs-script-actions', 'POST', body, token)).status).toBe(200);
		expect(first.fill).toHaveBeenCalledWith('#input', 'private-value', { timeout: 15000 });
		for (const property of ['evaluate', 'context', 'context.browser', 'setInputFiles', '__proto__.constructor']) {
			const result = await first.request('/ocs-script-actions', 'POST', { ...body, property }, token);
			expect(result.status).toBe(400);
			expect(result.body).not.toContain('private-value');
		}
		const otherPage = await first.request(
			'/ocs-script-actions',
			'POST',
			{ ...body, page: 'https://course.test/lesson?id=2' },
			token
		);
		expect(otherPage.status).toBe(404);
	});
	it('forbids screenshot file paths and rejects unbounded options before invoking Playwright', async () => {
		const screenshot = vi.fn();
		await expect(
			executeBridgeAction({ screenshot } as any, 'screenshot', [{ path: '/private/file.png' }])
		).rejects.toMatchObject({ code: 'INVALID_ACTION_ARGUMENTS' });
		expect(screenshot).not.toHaveBeenCalled();
		await expect(
			executeBridgeAction({ click: vi.fn() } as any, 'click', ['#button', { timeout: 0 }])
		).rejects.toMatchObject({ code: 'INVALID_ACTION_ARGUMENTS' });
	});
	it('returns bounded response bodies for the URL fragments used by official OCS scripts', async () => {
		const response = {
			url: () => 'https://course.test/studentExam/gateway/work?id=1',
			status: () => 200,
			headers: () => ({ 'content-type': 'application/json' }),
			body: async () => Buffer.from('{"questions":[]}')
		};
		const page = {
			waitForResponse: async (matches: (value: typeof response) => boolean) => {
				expect(matches(response)).toBe(true);
				return response;
			}
		};
		expect(await executeBridgeAction(page as any, 'waitForResponse', ['/studentExam/*/work'])).toMatchObject({
			status: 200,
			body: '{"questions":[]}'
		});
		await expect(
			executeBridgeAction(
				{ waitForResponse: async () => ({ ...response, headers: () => ({ 'content-length': '2097152' }) }) } as any,
				'waitForResponse',
				['/studentExam']
			)
		).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
	});
});

describe('automation diagnostics', () => {
	it('classifies failures without retaining passwords, tokens, URLs or call logs', () => {
		const secret = 'private-password-and-token';
		const diagnostic = automationDiagnostic(
			new Error(`Timeout while fill("${secret}") at https://example.test/?token=${secret}`)
		);
		expect(diagnostic.code).toBe('AUTOMATION_TIMEOUT');
		expect(JSON.stringify(diagnostic)).not.toContain(secret);
		expect(automationDiagnostic(`OCR_TIMEOUT ${secret}`).code).toBe('OCR_TIMEOUT');
		expect(automationDiagnostic(`密码错误 ${secret}`).code).toBe('LOGIN_REJECTED');
		expect(automationDiagnostic({ password: secret }).code).toBe('AUTOMATION_FAILED');
	});
});
