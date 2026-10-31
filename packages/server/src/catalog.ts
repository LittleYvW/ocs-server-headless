import { Router, type Request, type Response, type NextFunction } from 'express';
import { ApiError, bad, text } from './validation';
import { fetchRemoteText, remoteUrl } from './userscript-source';

export type CatalogProvider = 'official' | 'greasyfork' | 'scriptcat';
export interface CatalogScript {
	id: string;
	name: string;
	description: string;
	codeUrl: string;
	version?: string;
	homepage?: string;
	author?: string;
}
export interface CatalogVersion {
	version: string;
	codeUrl: string;
	publishedAt?: string;
}
export interface CatalogOptions {
	officialUrl?: string;
	greasyforkOrigin?: string;
	scriptcatOrigin?: string;
}

async function sourceJson(url: string): Promise<any> {
	const result = await fetchRemoteText(url);
	try {
		return JSON.parse(result.text);
	} catch {
		throw new ApiError(502, 'INVALID_CATALOG_RESPONSE', 'Script catalog returned invalid JSON');
	}
}
function list(value: unknown): any[] {
	if (!Array.isArray(value))
		throw new ApiError(502, 'INVALID_CATALOG_RESPONSE', 'Script catalog returned an invalid list');
	return value;
}
function string(value: unknown, limit = 2000): string {
	return typeof value === 'string' ? value.slice(0, limit) : '';
}
function optionalUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value) return undefined;
	try {
		return remoteUrl(value);
	} catch {
		return undefined;
	}
}
function provider(value: unknown): CatalogProvider {
	if (value !== 'official' && value !== 'greasyfork' && value !== 'scriptcat') bad('Unknown script catalog provider');
	return value as CatalogProvider;
}
function number(value: unknown, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum)
		bad('Invalid catalog pagination');
	return Number(value);
}

/** Source URLs are fixed provider endpoints; only search text, page and numeric script IDs are interpolated. */
export function createScriptCatalogRouter(options: CatalogOptions = {}): Router {
	const router = Router();
	const official = options.officialUrl || 'https://cdn.ocsjs.com/api/ocs-app-infos.json';
	const greasyfork = (options.greasyforkOrigin || 'https://greasyfork.org').replace(/\/+$/, '');
	const scriptcat = (options.scriptcatOrigin || 'https://scriptcat.org').replace(/\/+$/, '');
	const route = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => {
		Promise.resolve()
			.then(() => fn(req, res))
			.catch(next);
	};
	router.get(
		'/',
		route(async (req, res) => {
			const source = provider(req.query.provider || 'official');
			const query = req.query.q === undefined || req.query.q === '' ? '' : text(req.query.q, 'search text', 200);
			const page = number(req.query.page, 1, 1000);
			const limit = number(req.query.limit, 20, 50);
			let items: CatalogScript[];
			if (source === 'official') {
				const result = await sourceJson(official);
				const groups = list(result.resourceGroups);
				const files = groups.find((group) => group?.name === 'userjs')?.files || [];
				items = list(files)
					.filter((item) => optionalUrl(item?.url))
					.map((item, index) => ({
						id: string(String(item.id ?? index), 100),
						name: string(item.name, 200),
						description: string(item.description),
						codeUrl: optionalUrl(item.url)!,
						homepage: optionalUrl(item.homepage),
						version: string(item.version, 100) || undefined
					}));
				const term = query.toLocaleLowerCase();
				items = items.filter((item) => (item.name + ' ' + item.description).toLocaleLowerCase().includes(term));
				items = items.slice((page - 1) * limit, page * limit);
			} else if (source === 'greasyfork') {
				const result = await sourceJson(
					greasyfork + '/zh-CN/scripts.json?' + new URLSearchParams({ q: query, page: String(page) })
				);
				items = list(result)
					.filter((item) => /^\d+$/.test(String(item?.id)) && optionalUrl(item?.code_url))
					.slice(0, limit)
					.map((item) => ({
						id: String(item.id),
						name: string(item.name, 200),
						description: string(item.description),
						codeUrl: optionalUrl(item.code_url)!,
						version: string(item.version, 100) || undefined,
						homepage: optionalUrl(item.url),
						author: Array.isArray(item.users)
							? item.users.map((user: any) => string(user?.name, 100)).join(', ')
							: undefined
					}));
			} else {
				const result = await sourceJson(
					scriptcat +
						'/api/v2/scripts?' +
						new URLSearchParams({ keyword: query, page: String(page), count: String(limit) })
				);
				items = list(result?.data?.list)
					.filter((item) => /^\d+$/.test(String(item?.script?.script_id)))
					.slice(0, limit)
					.map((item) => ({
						id: String(item.script.script_id),
						name: string(item.name, 200),
						description: string(item.description),
						codeUrl:
							scriptcat +
							'/scripts/code/' +
							item.script.script_id +
							'/' +
							encodeURIComponent(string(item.name, 200)) +
							'.user.js',
						version: string(item.script.version, 100) || undefined,
						homepage: scriptcat + '/script-show-page/' + item.script.script_id,
						author: string(item.username, 100) || undefined
					}));
			}
			res.json({ data: { provider: source, page, items } });
		})
	);
	router.get(
		'/:provider/:id/versions',
		route(async (req, res) => {
			const source = provider(req.params.provider);
			if (source === 'official') {
				res.json({ data: [] });
				return;
			}
			const scriptId = req.params.id;
			if (!/^\d{1,16}$/.test(scriptId)) bad('Invalid catalog script ID');
			let versions: CatalogVersion[];
			if (source === 'greasyfork') {
				const result = await sourceJson(greasyfork + '/zh-CN/scripts/' + scriptId + '/versions.json');
				versions = list(result)
					.filter((item) => typeof item?.version === 'string' && optionalUrl(item.code_url))
					.slice(0, 200)
					.map((item) => ({
						version: string(item.version, 100),
						codeUrl: optionalUrl(item.code_url)!,
						publishedAt: string(item.created_at, 100) || undefined
					}));
			} else {
				const result = await sourceJson(scriptcat + '/api/v2/scripts/' + scriptId + '/versions');
				const scriptName = req.query.name === undefined ? 'script' : text(req.query.name, 'script name', 200);
				versions = list(result?.data?.list)
					.filter((item) => typeof item?.version === 'string')
					.slice(0, 200)
					.map((item) => ({
						version: string(item.version, 100),
						codeUrl:
							scriptcat +
							'/scripts/code/' +
							scriptId +
							'/' +
							encodeURIComponent(scriptName) +
							'.user.js?' +
							new URLSearchParams({ version: item.version }),
						publishedAt:
							typeof item.createtime === 'number' &&
							Number.isFinite(item.createtime) &&
							item.createtime > 0 &&
							item.createtime < 8640000000000
								? new Date(item.createtime * 1000).toISOString()
								: undefined
					}));
			}
			res.json({ data: versions });
		})
	);
	return router;
}
