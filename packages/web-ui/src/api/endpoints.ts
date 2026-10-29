import { request, requestBlob, type BlobOptions } from './client';
import type {
	AutomationDefinition,
	BrowserPayload,
	BrowserView,
	DownloadItem,
	PageInfo,
	RuntimeState,
	ScriptPayload,
	ServiceEvent,
	SettingsPayload,
	SystemInfo,
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
		remove: (id: string) => request<void>(`${base}/user-scripts/${encodeURIComponent(id)}`, { method: 'DELETE' })
	},

	settings: {
		get: () => request<SettingsPayload>(`${base}/settings`),
		update: (ocs: Record<string, unknown>) =>
			request<SettingsPayload>(`${base}/settings`, { method: 'PATCH', body: { ocs } })
	}
};
