import { Router, json, type Request, type Response, type NextFunction } from 'express';
import fs from 'node:fs/promises';
import type { ServerConfig } from './config';
import { ApiError } from './api-error';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const disabled = () => new ApiError(503, 'QUESTION_BANK_DISABLED', 'Question bank is not configured');
const unavailable = () => new ApiError(503, 'QUESTION_BANK_UNAVAILABLE', 'Question bank is unavailable');

async function call(
	config: ServerConfig,
	path: string,
	method: Method,
	body: unknown,
	authorization?: string,
	signal?: AbortSignal
): Promise<{ status: number; body: any }> {
	if (!config.questionBank) throw disabled();
	if (authorization === undefined) {
		let token: string;
		try {
			token = (await fs.readFile(config.questionBank.tokenFile, 'utf8')).trim();
		} catch {
			throw unavailable();
		}
		if (token.length < 32 || /\s/.test(token)) throw unavailable();
		authorization = 'Bearer ' + token;
	}
	const controller = new AbortController();
	try {
		const response = await fetch(config.questionBank.url + path, {
			method,
			headers: { Authorization: authorization, 'Content-Type': 'application/json' },
			body: ['GET', 'DELETE'].includes(method) ? undefined : JSON.stringify(body ?? {}),
			redirect: 'error',
			signal: AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(path.startsWith('/query') ? 58000 : 10000),
				...(signal ? [signal] : [])
			])
		});
		const reader = response.body?.getReader();
		if (!reader) throw unavailable();
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.length;
			if (size > 8 * 1024 * 1024) {
				await reader.cancel();
				throw unavailable();
			}
			chunks.push(next.value);
		}
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unavailable();
		return { status: response.status, body: parsed };
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw unavailable();
	} finally {
		controller.abort();
	}
}

/** Public OCS protocol: query credentials only, without access to the management router. */
export function createQuestionBankQueryRouter(config: ServerConfig): Router {
	const router = Router();
	router.use((_req, res, next) => {
		res.set({
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': 'Authorization, Content-Type',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
		});
		next();
	});
	router.options('/query', (_req, res) => res.sendStatus(204));
	router.use(json({ limit: '64kb', strict: true }));
	for (const method of ['get', 'post'] as const) {
		router[method]('/query', async (req, res, next) => {
			const abort = new AbortController();
			const closed = () => abort.abort();
			res.once('close', closed);
			try {
				const authorization = req.get('authorization') || '';
				if (!/^Bearer [a-f0-9]{64}$/i.test(authorization)) {
					throw new ApiError(401, 'UNAUTHORIZED', 'A valid query token is required');
				}
				const search = method === 'get' && req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
				const result = await call(
					config,
					'/query' + search,
					method.toUpperCase() as Method,
					req.body,
					authorization,
					abort.signal
				);
				if (!res.destroyed) {
					if (result.status === 429) res.set('Retry-After', '60');
					res.status(result.status).json(result.body);
				}
			} catch (error) {
				if (!res.destroyed) next(error);
			} finally {
				res.off('close', closed);
			}
		});
	}
	router.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
		const status = error instanceof ApiError ? error.status : error.type === 'entity.too.large' ? 413 : 400;
		const code = error instanceof ApiError ? error.code : status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON';
		const message = error instanceof ApiError ? error.message : 'Invalid query body';
		res.status(status).json({ code: 0, data: null, message, error: { code, message } });
	});
	return router;
}

/** Mounted inside /api/v1, after its existing administrator and Origin checks. */
export function createQuestionBankManagementRouter(config: ServerConfig): Router {
	const router = Router();
	router.post('/connections', async (req, res, next) => {
		try {
			const input = req.body;
			if (
				!input ||
				typeof input !== 'object' ||
				Array.isArray(input) ||
				Object.keys(input).some((key) => !['name', 'baseUrl'].includes(key)) ||
				typeof input.name !== 'string' ||
				!input.name.trim() ||
				input.name.length > 100 ||
				typeof input.baseUrl !== 'string' ||
				input.baseUrl.length > 2000
			)
				throw new ApiError(400, 'INVALID_INPUT', 'name and baseUrl are required');
			let base: URL;
			try {
				base = new URL(input.baseUrl);
			} catch {
				throw new ApiError(400, 'INVALID_INPUT', 'Invalid baseUrl');
			}
			if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
				throw new ApiError(400, 'INVALID_INPUT', 'Invalid baseUrl');
			const result = await call(config, '/admin/tokens', 'POST', { name: input.name });
			if (result.status !== 200) {
				res.status(result.status).json(result.body);
				return;
			}
			const client = result.body.data;
			if (!client || typeof client.token !== 'string' || !/^[a-f0-9]{64}$/.test(client.token)) throw unavailable();
			const queryUrl = base.toString().replace(/\/+$/, '') + '/question-bank/query';
			const wrapper = [
				{
					name: 'ZError 自建题库',
					url: queryUrl,
					method: 'post',
					type: 'GM_xmlhttpRequest',
					responseType: 'json',
					headers: { Authorization: 'Bearer ' + client.token, 'Content-Type': 'application/json' },
					data: { title: '${title}', options: '${options}', type: '${type}' },
					handler:
						'return (res)=>res.code === 1 && res.data ? [res.data.question,res.data.answer,{ai:res.data.is_ai}] : [res.message,undefined]'
				}
			];
			res.status(201).json({ data: { client, queryUrl, wrapper } });
		} catch (error) {
			next(error);
		}
	});
	router.use(async (req, res, next) => {
		const routes: [RegExp, string[]][] = [
			[/^\/status$/, ['GET']],
			[/^\/settings$/, ['GET', 'PATCH']],
			[/^\/tokens$/, ['GET', 'POST']],
			[/^\/tokens\/[a-f0-9-]{36}$/, ['DELETE']],
			[/^\/questions$/, ['GET', 'POST']],
			[/^\/questions\/import$/, ['POST']],
			[/^\/questions\/[1-9]\d*$/, ['GET', 'PUT', 'DELETE']],
			[/^\/folders$/, ['GET', 'POST']],
			[/^\/folders\/\d+$/, ['PUT', 'DELETE']],
			[/^\/logs$/, ['GET']]
		];
		if (!routes.some(([pattern, methods]) => pattern.test(req.path) && methods.includes(req.method))) {
			next(new ApiError(404, 'NOT_FOUND', 'Route not found'));
			return;
		}
		try {
			if (req.path === '/status' && !config.questionBank) {
				res.json({ data: { configured: false, available: false } });
				return;
			}
			const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
			const result = await call(config, '/admin' + req.path + query, req.method as Method, req.body);
			res
				.status(result.status)
				.json(
					req.path === '/status' && result.status === 200
						? { data: { ...result.body.data, configured: true, available: true } }
						: result.body
				);
		} catch (error) {
			next(error);
		}
	});
	return router;
}
