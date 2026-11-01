import { apiBase } from './client';
import type { QuestionQueryData, QuestionQueryPayload } from './types';

/**
 * Independent query transport for the public OCS question-bank protocol.
 *
 * This must never reuse the management client: that one attaches the admin
 * Bearer token. A query 401 only means "this query token is invalid" and must
 * not end the administrator session, so nothing here calls the unauthorized
 * handler or session storage.
 */

export interface QueryResult {
	ok: boolean;
	status: number;
	/** Stable server error code, or a transport code such as CLIENT_TIMEOUT. */
	code: string;
	message: string;
	data?: QuestionQueryData;
	durationMs: number;
	retryAfterSeconds?: number;
}

/** The gateway waits up to 58s for a query; stop a little later than that. */
const QUERY_TIMEOUT_MS = 60_000;

interface RawQueryReply {
	code?: number;
	data?: QuestionQueryData | null;
	message?: string;
	error?: { code?: string; message?: string };
}

export async function queryQuestionBank(
	payload: QuestionQueryPayload,
	token: string,
	options: { signal?: AbortSignal } = {}
): Promise<QueryResult> {
	const started = Date.now();
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, QUERY_TIMEOUT_MS);
	const forward = () => controller.abort();
	options.signal?.addEventListener('abort', forward, { once: true });
	if (options.signal?.aborted) controller.abort();
	const elapsed = () => Date.now() - started;

	try {
		let response: Response;
		try {
			response = await fetch(`${apiBase()}/question-bank/query`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
					Authorization: `Bearer ${token}`
				},
				body: JSON.stringify(payload),
				credentials: 'omit',
				signal: controller.signal
			});
		} catch (error) {
			if (timedOut) {
				return { ok: false, status: 0, code: 'CLIENT_TIMEOUT', message: '查询等待超过 60 秒。', durationMs: elapsed() };
			}
			if ((error as DOMException | undefined)?.name === 'AbortError') throw error;
			return {
				ok: false,
				status: 0,
				code: 'NETWORK_ERROR',
				message: '无法连接题库查询接口。',
				durationMs: elapsed()
			};
		}

		let body: RawQueryReply | undefined;
		try {
			body = (await response.json()) as RawQueryReply;
		} catch (error) {
			if (controller.signal.aborted) throw error;
			// Non-JSON bodies only leave the HTTP status to report.
		}
		const durationMs = elapsed();
		const retryAfter = Number(response.headers.get('retry-after') || 0) || undefined;
		if (response.ok && body?.code === 1 && body.data) {
			return { ok: true, status: response.status, code: 'OK', message: '', data: body.data, durationMs };
		}
		const code = body?.error?.code || `HTTP_${response.status}`;
		const message = body?.message || body?.error?.message || `请求失败（HTTP ${response.status}）`;
		return { ok: false, status: response.status, code, message, durationMs, retryAfterSeconds: retryAfter };
	} catch (error) {
		if (timedOut) {
			return { ok: false, status: 0, code: 'CLIENT_TIMEOUT', message: '查询等待超过 60 秒。', durationMs: elapsed() };
		}
		throw error;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', forward);
	}
}
