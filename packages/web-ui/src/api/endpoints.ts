import { request, requestBlob, type BlobOptions } from './client';
import type {
	AutomationDefinition,
	BrowserStorage,
	DataImportSummary,
	BrowserPayload,
	BrowserView,
	DownloadItem,
	PageInfo,
	RuntimeState,
	ScriptPayload,
	ScriptUpdateCheck,
	CatalogProvider,
	CatalogScript,
	CatalogVersion,
	ServiceEvent,
	SettingsPayload,
	SystemInfo,
	StorageTarget,
	UserScript
} from './types';

const base = '/api/v1';

export const api = {
	system: () => request<SystemInfo>(`${base}/system`),
	automationScripts: () => request<AutomationDefinition[]>(`${base}/automation-scripts`),
	logs: (limit = 200) => request<ServiceEvent[]>(`${base}/logs?limit=${limit}`),

	browsers: {
		list: () => request<BrowserView[]>(`${base}/browsers`),
		get: (id: string) => request<BrowserView>(`${base}/browsers/${encodeURIComponent(id)}`),
		create: (payload: BrowserPayload) => request<BrowserView>(`${base}/browsers`, { method: 'POST', body: payload }),
		update: (id: string, payload: BrowserPayload) =>
			request<BrowserView>(`${base}/browsers/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
		remove: (id: string) => request<void>(`${base}/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
		action: (id: string, action: 'start' | 'stop' | 'restart') =>
			request<RuntimeState>(`${base}/browsers/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
		pages: (id: string) => request<PageInfo[]>(`${base}/browsers/${encodeURIComponent(id)}/pages`),
		navigate: (id: string, url: string, pageId?: string) =>
			request<PageInfo>(`${base}/browsers/${encodeURIComponent(id)}/navigate`, {
				method: 'POST',
				body: pageId ? { url, pageId } : { url }
			}),
		click: (id: string, selector: string, pageId?: string) =>
			request<{ completed: boolean }>(`${base}/browsers/${encodeURIComponent(id)}/click`, {
				method: 'POST',
				body: pageId ? { selector, pageId } : { selector }
			}),
		fill: (id: string, selector: string, text: string, pageId?: string) =>
			request<{ completed: boolean }>(`${base}/browsers/${encodeURIComponent(id)}/fill`, {
				method: 'POST',
				body: pageId ? { selector, text, pageId } : { selector, text }
			}),
		screenshot: (id: string, pageId: string | undefined, options: BlobOptions = {}) =>
			requestBlob(
				`${base}/browsers/${encodeURIComponent(id)}/screenshot${pageId ? `?pageId=${encodeURIComponent(pageId)}` : ''}`,
				options
			),
		downloads: (id: string) => request<DownloadItem[]>(`${base}/browsers/${encodeURIComponent(id)}/downloads`),
		download: (id: string, filename: string, options: BlobOptions = {}) =>
			requestBlob(`${base}/browsers/${encodeURIComponent(id)}/downloads/${encodeURIComponent(filename)}`, options)
	},

	scripts: {
		list: () => request<UserScript[]>(`${base}/user-scripts`),
		get: (id: string) => request<UserScript>(`${base}/user-scripts/${encodeURIComponent(id)}`),
		create: (payload: ScriptPayload) => request<UserScript>(`${base}/user-scripts`, { method: 'POST', body: payload }),
		update: (id: string, payload: ScriptPayload) =>
			request<UserScript>(`${base}/user-scripts/${encodeURIComponent(id)}`, { method: 'PATCH', body: payload }),
		import: (payload: { url?: string; code?: string; name?: string; enabled?: boolean; pinned?: boolean }) =>
			request<UserScript>(`${base}/user-scripts/import`, { method: 'POST', body: payload }),
		catalog: (provider: CatalogProvider, q = '', page = 1) =>
			request<{ provider: CatalogProvider; page: number; items: CatalogScript[] }>(
				`${base}/script-catalog?${new URLSearchParams({ provider, q, page: String(page) })}`
			),
		versions: (provider: CatalogProvider, id: string, name: string) =>
			request<CatalogVersion[]>(
				`${base}/script-catalog/${provider}/${encodeURIComponent(id)}/versions?${new URLSearchParams({ name })}`
			),
		code: (id: string) => requestBlob(`${base}/user-scripts/${encodeURIComponent(id)}/code`),
		checkUpdate: (id: string) =>
			request<ScriptUpdateCheck>(`${base}/user-scripts/${encodeURIComponent(id)}/check-update`, { method: 'POST' }),
		applyUpdate: (id: string) =>
			request<UserScript>(`${base}/user-scripts/${encodeURIComponent(id)}/update`, { method: 'POST' }),
		remove: (id: string) => request<void>(`${base}/user-scripts/${encodeURIComponent(id)}`, { method: 'DELETE' })
	},

	data: {
		export: async (password: string) => {
			const data = await request<string>(`${base}/data/export`, { method: 'POST', body: { password } });
			return new Blob([JSON.stringify({ format: 'ocs-server-headless', version: 1, data })], {
				type: 'application/json'
			});
		},
		import: (content: string, password?: string) =>
			request<DataImportSummary>(`${base}/data/import`, { method: 'POST', body: { content, password } })
	},
	storage: {
		get: (id: string) => request<BrowserStorage>(`${base}/browsers/${encodeURIComponent(id)}/storage`),
		clear: (id: string, target: StorageTarget) =>
			request<BrowserStorage>(`${base}/browsers/${encodeURIComponent(id)}/storage`, {
				method: 'DELETE',
				body: { target }
			})
	},

	settings: {
		get: () => request<SettingsPayload>(`${base}/settings`),
		update: (ocs: Record<string, unknown>) =>
			request<SettingsPayload>(`${base}/settings`, { method: 'PATCH', body: { ocs } })
	}
};
