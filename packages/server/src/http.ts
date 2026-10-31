import express, { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { timingSafeEqual, createHash, randomUUID } from 'crypto';
import { AutomationScripts } from '@ocs-server/common/automation';
import { ServerConfig } from './config';
import { Store } from './store';
import { Events, ServiceEvent } from './events';
import { Runtime } from './runtime';
import { createUserScriptRouter } from './userscripts';
import { createTransferRouter } from './transfer';
import { createStorageRouter } from './storage';
import { hostResources } from './resource';
import { createScriptCatalogRouter } from './catalog';
import { ApiError, bad, missing, object, fields, text, url, id, browserInput, publicBrowser } from './validation';

const digest = (s: string) => createHash('sha256').update(s).digest();

// The console is a static SPA shell. It needs its own narrow policy: styles are
// inlined by Vue bindings, screenshots are blob: URLs, and no inline scripts run.
const WEB_CSP =
	"default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
	"script-src 'self'; connect-src 'self'; font-src 'self' data:; base-uri 'none'; " +
	"form-action 'self'; frame-ancestors 'none'; object-src 'none'";

export function createApp(config: ServerConfig, store: Store, runtime: Runtime, events: Events) {
	const app = express();
	app.disable('x-powered-by');
	app.use((_req, res, next) => {
		res.set({
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'no-store',
			'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
		});
		next();
	});
	app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
	app.use('/api/v1', (req, res, next) => {
		const origin = req.get('origin');
		const hostOrigin = `${req.protocol}://${req.get('host')}`;
		if (origin && origin !== hostOrigin && !config.allowedOrigins.includes(origin)) {
			return next(new ApiError(403, 'ORIGIN_DENIED', 'Origin is not allowed'));
		}
		if (origin) {
			res.set('Access-Control-Allow-Origin', origin);
			res.vary('Origin');
		}
		if (req.method === 'OPTIONS') {
			res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Last-Event-ID');
			res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
			return res.sendStatus(204);
		}
		const auth = req.get('authorization') || '';
		if (!auth.startsWith('Bearer ') || !timingSafeEqual(digest(auth.slice(7)), digest(config.token))) {
			res.set('WWW-Authenticate', 'Bearer');
			return next(new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required'));
		}
		next();
	});
	app.use('/api/v1/data', express.json({ limit: '30mb', strict: true }));
	app.use('/api/v1/user-scripts', express.json({ limit: '3mb', strict: true }));
	app.use('/api/v1', express.json({ limit: '1mb', strict: true }));
	const api = express.Router();
	app.use('/api/v1', api);
	const route = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
		Promise.resolve()
			.then(() => fn(req, res))
			.catch(next);
	};
	const data = (res: Response, value: unknown, status = 200) => res.status(status).json({ data: value });
	const profile = (value: string) => store.read().browsers.find((p) => p.id === id(value)) || missing();
	const stopped = (value: string) => {
		if (runtime.get(value).pid || ['starting', 'running', 'stopping'].includes(runtime.get(value).status))
			throw new ApiError(409, 'BROWSER_BUSY', 'Stop the browser before changing its configuration');
	};
	const view = (p: ReturnType<typeof profile>) => ({ ...publicBrowser(p), runtime: runtime.get(p.id) });
	const scriptsExist = (ids: string[]) => {
		const scripts = store.read().userScripts;
		if (ids.some((value) => !scripts.some((s) => s.id === value))) bad('Unknown user script');
		const identities = new Set<string>();
		for (const script of scripts.filter(
			(item) => ids.includes(item.id) && item.enabled && item.mode === 'userscript'
		)) {
			const identity = JSON.stringify([
				script.metadata?.values.namespace?.[0] || '',
				script.metadata?.values.name?.[0] || script.name
			]);
			if (identities.has(identity)) bad('Selected userscripts have the same name and namespace');
			identities.add(identity);
		}
	};
	api.get(
		'/system',
		route((_req, res) =>
			data(res, {
				name: 'ocs-server-headless',
				apiVersion: 1,
				node: process.version,
				platform: process.platform,
				headless: true,
				ocrAvailable: !!config.ocrUrl,
				resources: hostResources(),
				resourcePolicy: { minFreeMemoryMB: config.minFreeMemoryMB, maxCpuPercent: config.maxCpuPercent },
				maxBrowsers: config.maxBrowsers,
				browsers: runtime.list(),
				capabilities: [
					'persistent-profiles',
					'automation-scripts',
					'plain-user-scripts',
					'standard-user-scripts',
					'userscript-import-update',
					'ocs-config-sync',
					'ocs-actions',
					'encrypted-data-transfer',
					'resource-monitoring',
					'screenshots',
					'page-actions',
					'downloads',
					'sse'
				]
			})
		)
	);
	api.get(
		'/automation-scripts',
		route((_req, res) =>
			data(
				res,
				AutomationScripts.map((s) => ({
					name: s.name,
					icon: s.icon,
					configs: s.configs,
					needOCR: !!s.needOCR,
					ocrAvailable: !!config.ocrUrl
				}))
			)
		)
	);
	api.get(
		'/browsers',
		route((_req, res) => data(res, store.read().browsers.map(view)))
	);
	api.post(
		'/browsers',
		route((req, res) => {
			const input = browserInput(req.body);
			scriptsExist(input.userScriptIds);
			if (store.read().browsers.length >= 1000) throw new ApiError(409, 'LIMIT_REACHED', 'Profile limit reached');
			const now = new Date().toISOString();
			const item = { ...input, id: randomUUID(), createdAt: now, updatedAt: now };
			store.update((db) => db.browsers.push(item));
			events.publish('browser.created', { profileId: item.id });
			return data(res, view(item), 201);
		})
	);
	api.get(
		'/browsers/:id',
		route((req, res) => data(res, view(profile(req.params.id))))
	);
	api.patch(
		'/browsers/:id',
		route((req, res) => {
			const previous = profile(req.params.id);
			stopped(previous.id);
			const input = browserInput(req.body, previous);
			scriptsExist(input.userScriptIds);
			const item = { ...previous, ...input, updatedAt: new Date().toISOString() };
			store.update((db) => {
				db.browsers[db.browsers.findIndex((p) => p.id === item.id)] = item;
			});
			events.publish('browser.updated', { profileId: item.id });
			return data(res, view(item));
		})
	);
	api.delete(
		'/browsers/:id',
		route((req, res) => {
			const item = profile(req.params.id);
			stopped(item.id);
			store.update((db) => {
				db.browsers = db.browsers.filter((p) => p.id !== item.id);
			});
			events.publish('browser.deleted', { profileId: item.id });
			res.sendStatus(204);
		})
	);
	for (const action of ['start', 'stop', 'restart'] as const) {
		api.post(
			`/browsers/:id/${action}`,
			route(async (req, res) => {
				const item = profile(req.params.id);
				if (action !== 'stop') scriptsExist(item.userScriptIds);
				const scripts = store.read().userScripts.filter((s) => item.userScriptIds.includes(s.id) && s.enabled);
				return data(
					res,
					action === 'stop'
						? await runtime.stop(item.id)
						: await runtime[action](item, scripts, store.read().settings.ocs)
				);
			})
		);
	}
	api.get(
		'/browsers/:id/pages',
		route(async (req, res) => data(res, await runtime.command(profile(req.params.id).id, 'pages', {})))
	);
	for (const action of ['navigate', 'click', 'fill'] as const) {
		api.post(
			`/browsers/:id/${action}`,
			route(async (req, res) => {
				const item = profile(req.params.id);
				const body = object(req.body);
				fields(
					body,
					action === 'navigate'
						? ['url', 'pageId']
						: action === 'click'
						? ['selector', 'pageId']
						: ['selector', 'text', 'pageId']
				);
				const payload: Record<string, string> = {};
				if (body.pageId !== undefined) payload.pageId = text(body.pageId, 'pageId', 100);
				if (action === 'navigate') payload.url = url(body.url);
				else payload.selector = text(body.selector, 'selector', 2000);
				if (action === 'fill') {
					if (typeof body.text !== 'string' || body.text.length > 100000) bad('Invalid text');
					payload.text = body.text;
				}
				return data(res, await runtime.command(item.id, action, payload));
			})
		);
	}
	api.get(
		'/browsers/:id/screenshot',
		route(async (req, res) => {
			const pageId = req.query.pageId === undefined ? undefined : text(req.query.pageId, 'pageId', 100);
			const shot = await runtime.command(profile(req.params.id).id, 'screenshot', { pageId });
			res.type('png').send(Buffer.from(shot.base64, 'base64'));
		})
	);
	for (const action of ['new-page', 'close-page', 'reload', 'press', 'check', 'select'] as const) {
		api.post(
			`/browsers/:id/${action}`,
			route(async (req, res) => {
				const body = object(req.body || {});
				const allowed =
					action === 'new-page'
						? ['url']
						: [
								'pageId',
								...(action === 'press'
									? ['selector', 'key']
									: action === 'check'
									? ['selector', 'checked']
									: action === 'select'
									? ['selector', 'values']
									: [])
						  ];
				fields(body, allowed);
				const payload: Record<string, unknown> = {};
				if (body.pageId !== undefined) payload.pageId = text(body.pageId, 'pageId', 100);
				if (action === 'close-page' && !payload.pageId) bad('pageId is required');
				if (action === 'new-page') payload.url = body.url === undefined ? 'about:blank' : url(body.url);
				if (['press', 'check', 'select'].includes(action)) payload.selector = text(body.selector, 'selector', 2000);
				if (action === 'press') payload.key = text(body.key, 'key', 100);
				if (action === 'check') {
					if (body.checked !== undefined && typeof body.checked !== 'boolean') bad('checked must be boolean');
					payload.checked = body.checked ?? true;
				}
				if (action === 'select') {
					if (
						!Array.isArray(body.values) ||
						body.values.length > 100 ||
						body.values.some((value: unknown) => typeof value !== 'string' || value.length > 2000)
					)
						bad('Invalid select values');
					payload.values = body.values;
				}
				return data(res, await runtime.command(profile(req.params.id).id, action, payload));
			})
		);
	}
	api.get(
		'/browsers/:id/downloads',
		route((req, res) => {
			const dir = path.join(config.dataDir, 'downloads', profile(req.params.id).id);
			const items = fs.existsSync(dir)
				? fs
						.readdirSync(dir, { withFileTypes: true })
						.filter((f) => f.isFile() && !f.isSymbolicLink())
						.map((f) => ({ filename: f.name, size: fs.statSync(path.join(dir, f.name)).size }))
				: [];
			return data(res, items);
		})
	);
	api.get(
		'/browsers/:id/preview',
		route(async (req, res) => {
			const profileId = profile(req.params.id).id;
			const pageId = req.query.pageId === undefined ? undefined : text(req.query.pageId, 'pageId', 100);
			res.set({ 'Content-Type': 'multipart/x-mixed-replace; boundary=ocs-frame', 'X-Accel-Buffering': 'no' });
			let release: (() => void) | undefined;
			res.once('close', () => release?.());
			release = await runtime.preview(profileId, { pageId }, async (frame) => {
				if (frame.ended) {
					res.end();
					return;
				}
				if (res.destroyed || res.writableEnded || typeof frame.base64 !== 'string') return;
				const bytes = Buffer.from(frame.base64, 'base64');
				const header = Buffer.from(
					`--ocs-frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${bytes.length}\r\n\r\n`
				);
				if (!res.write(Buffer.concat([header, bytes, Buffer.from('\r\n')]))) {
					await new Promise<void>((resolve) => {
						const done = () => {
							res.off('drain', done);
							res.off('close', done);
							resolve();
						};
						res.once('drain', done);
						res.once('close', done);
					});
				}
			});
			if (res.destroyed) release();
			else res.flushHeaders();
		})
	);
	api.get(
		'/browsers/:id/downloads/:filename',
		route((req, res) => {
			const dir = path.join(config.dataDir, 'downloads', profile(req.params.id).id);
			const filename = req.params.filename;
			if (filename !== path.basename(filename) || /[\\/\x00-\x1f]/.test(filename)) return missing();
			const file = path.join(dir, filename);
			if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file))
				return missing();
			res.download(file, filename);
		})
	);
	api.use('/user-scripts', createUserScriptRouter(config, store, events));
	api.use('/script-catalog', createScriptCatalogRouter());
	api.use('/data', createTransferRouter(store, runtime, events));
	api.use('/browsers', createStorageRouter(store, runtime, events));
	api.get(
		'/settings',
		route((_req, res) => data(res, store.read().settings))
	);
	api.patch(
		'/settings',
		route(async (req, res) => {
			const body = object(req.body);
			fields(body, ['ocs']);
			const ocs = object(body.ocs);
			store.update((db) => {
				db.settings.ocs = ocs;
			});
			await runtime.syncOCS(ocs);
			events.publish('settings.updated', {});
			return data(res, store.read().settings);
		})
	);
	api.get(
		'/logs',
		route((req, res) => {
			const limit = Number(req.query.limit ?? 100);
			if (!Number.isInteger(limit) || limit < 1 || limit > 500) bad('limit must be between 1 and 500');
			return data(res, events.list(limit));
		})
	);
	api.get(
		'/events',
		route((req, res) => {
			if (events.listenerCount('event') >= 64)
				throw new ApiError(503, 'CONNECTION_LIMIT', 'Event connection limit reached');
			res.set({ 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
			res.flushHeaders();
			const write = (event: ServiceEvent) => {
				if (res.destroyed || res.writableEnded) return;
				if (!res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) {
					events.off('event', write);
					res.end();
				}
			};
			res.write(': connected\n\n');
			const after = Number(req.get('last-event-id') || 0);
			if (after) {
				for (const event of events.list(500).filter((e) => e.id > after)) {
					write(event);
					if (res.writableEnded || res.destroyed) return;
				}
			}
			events.on('event', write);
			const heartbeat = setInterval(() => {
				if (res.destroyed || res.writableEnded) return;
				if (!res.write(': heartbeat\n\n')) res.end();
			}, 15000);
			const cleanup = () => {
				clearInterval(heartbeat);
				events.off('event', write);
			};
			res.on('close', cleanup);
			res.on('error', cleanup);
		})
	);
	// Mount the console after the API so /api/* can never be shadowed by a file
	// under the web root; unknown non-API paths fall through to the JSON 404.
	// Static console hosting is optional: without a build, API routing is unchanged.
	app.use(
		express.static(config.webDir, {
			dotfiles: 'deny',
			index: 'index.html',
			redirect: false,
			setHeaders(res, file) {
				res.setHeader('Content-Security-Policy', WEB_CSP);
				if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
				else if (file.split(path.sep).includes('assets')) {
					res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
				} else res.setHeader('Cache-Control', 'public, max-age=3600');
			}
		})
	);
	app.use((_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));
	app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
		if (res.headersSent) return res.end();
		const known = typeof error.status === 'number' && typeof error.code === 'string';
		const status = known
			? error.status
			: error.type === 'entity.too.large'
			? 413
			: error instanceof SyntaxError
			? 400
			: 500;
		res
			.type('application/json')
			.status(status)
			.json({
				error: {
					code: known
						? error.code
						: status === 413
						? 'BODY_TOO_LARGE'
						: status === 400
						? 'INVALID_JSON'
						: 'INTERNAL_ERROR',
					message: known ? error.message : status === 500 ? 'Internal server error' : 'Invalid request body'
				}
			});
	});
	return app;
}
