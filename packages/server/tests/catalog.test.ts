import { beforeEach, afterEach, it, expect } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createScriptCatalogRouter } from '../src/catalog';
import { ApiError } from '../src/validation';

let fixture: Server;
let server: Server;
let base: string;
let origin: string;
let malformed: boolean;
let requests: URL[];
async function listen(service: Server): Promise<string> {
	await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
}
beforeEach(async () => {
	malformed = false;
	requests = [];
	fixture = createServer((req, res) => {
		const url = new URL(req.url!, 'http://localhost');
		requests.push(url);
		if (malformed) {
			res.end('<html>upstream error</html>');
			return;
		}
		let data: unknown;
		if (url.pathname === '/official')
			data = {
				resourceGroups: [
					{ name: 'extensions', files: [] },
					{
						name: 'userjs',
						files: [
							{
								id: 'official-script',
								name: 'OCS 官方脚本',
								description: 'fixture only',
								url: origin + '/source.user.js'
							},
							{ id: 'invalid', name: 'unsafe', url: 'file:///etc/passwd' }
						]
					}
				]
			};
		else if (url.pathname === '/greasy/zh-CN/scripts.json')
			data = [
				{
					id: 123,
					name: 'GF Script',
					description: 'fixture',
					version: '2.0',
					code_url: origin + '/gf.user.js',
					url: origin + '/gf',
					users: [{ name: 'Author' }]
				}
			];
		else if (url.pathname === '/greasy/zh-CN/scripts/123/versions.json')
			data = [{ version: '1.0', code_url: origin + '/gf.user.js?version=100', created_at: '2026-01-01T00:00:00Z' }];
		else if (url.pathname === '/cat/api/v2/scripts')
			data = {
				data: {
					list: [
						{ name: '测试 #&', username: 'Author', description: 'fixture', script: { script_id: 42, version: '3.0' } }
					]
				}
			};
		else if (url.pathname === '/cat/api/v2/scripts/42/versions')
			data = { data: { list: [{ version: '2.0-beta', createtime: 1700000000 }] } };
		else {
			res.writeHead(404).end();
			return;
		}
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify(data));
	});
	origin = await listen(fixture);
	const app = express();
	app.use(
		'/catalog',
		createScriptCatalogRouter({
			officialUrl: origin + '/official',
			greasyforkOrigin: origin + '/greasy',
			scriptcatOrigin: origin + '/cat'
		})
	);
	app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
		res
			.status(error instanceof ApiError ? error.status : 500)
			.json({ error: { code: error instanceof ApiError ? error.code : 'INTERNAL_ERROR' } });
	});
	server = createServer(app);
	base = await listen(server);
});
afterEach(async () => {
	for (const service of [server, fixture]) {
		service.closeAllConnections();
		await new Promise<void>((resolve) => service.close(() => resolve()));
	}
});
async function result(query: string): Promise<any> {
	return ((await (await fetch(base + '/catalog' + query)).json()) as any).data;
}

it('filters the official userscript resource group and rejects unsafe code links', async () => {
	const data = await result('?provider=official&q=' + encodeURIComponent('官方'));
	expect(data.items).toHaveLength(1);
	expect(data.items[0]).toMatchObject({
		id: 'official-script',
		name: 'OCS 官方脚本',
		codeUrl: origin + '/source.user.js'
	});
	expect((await result('?provider=official&page=2&limit=1')).items).toEqual([]);
});

it('maps GreasyFork search and historical code URLs without dropping version pins', async () => {
	const keyword = 'test & other?字';
	const data = await result('?provider=greasyfork&q=' + encodeURIComponent(keyword) + '&page=2');
	expect(requests[0].searchParams.get('q')).toBe(keyword);
	expect(requests[0].searchParams.get('page')).toBe('2');
	expect(data.items[0]).toMatchObject({ id: '123', name: 'GF Script', author: 'Author', version: '2.0' });
	const versions = await result('/greasyfork/123/versions');
	expect(versions[0].codeUrl).toBe(origin + '/gf.user.js?version=100');
});

it('maps ScriptCat search and encodes names and historical version parameters', async () => {
	const data = await result('?provider=scriptcat&q=fixture&limit=5');
	expect(data.items[0]).toMatchObject({ id: '42', name: '测试 #&', version: '3.0' });
	expect(new URL(data.items[0].codeUrl).pathname).toBe(
		'/cat/scripts/code/42/' + encodeURIComponent('测试 #&') + '.user.js'
	);
	const versions = await result('/scriptcat/42/versions?name=' + encodeURIComponent('测试 #&'));
	expect(new URL(versions[0].codeUrl).searchParams.get('version')).toBe('2.0-beta');
	expect(new URL(versions[0].codeUrl).pathname).toBe(new URL(data.items[0].codeUrl).pathname);
	expect(versions[0].publishedAt).toBe('2023-11-14T22:13:20.000Z');
});

it('rejects invalid providers, pagination and script IDs before fetching; reports malformed source responses', async () => {
	for (const query of ['?provider=arbitrary', '?page=0', '?limit=1000', '/greasyfork/not-an-id/versions'])
		expect((await fetch(base + '/catalog' + query)).status).toBe(400);
	expect(requests).toHaveLength(0);
	malformed = true;
	const response = await fetch(base + '/catalog');
	expect(response.status).toBe(502);
	expect(((await response.json()) as any).error.code).toBe('INVALID_CATALOG_RESPONSE');
});
