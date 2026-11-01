import { request, requestBlob, type BlobOptions } from './client';
import type {
	AutomationDefinition,
	BrowserStorage,
	DataImportSummary,
	BrowserPayload,
	BrowserView,
	BrowserControlSession,
	BrowserInputEvent,
	BrowserInputResult,
	DownloadItem,
	PageInfo,
	QuestionBankClient,
	QuestionBankConnection,
	QuestionBankFolder,
	QuestionBankImportResult,
	QuestionBankLog,
	QuestionBankModelConfig,
	QuestionBankQuestion,
	QuestionBankQuestionPage,
	QuestionBankSettings,
	QuestionBankStatus,
	QuestionInput,
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
		newPage: (id: string, url?: string) =>
			request<PageInfo>(`${base}/browsers/${encodeURIComponent(id)}/new-page`, {
				method: 'POST',
				body: url ? { url } : {}
			}),
		pageAction: (id: string, action: 'close-page' | 'reload' | 'go-back' | 'go-forward', pageId: string) =>
			request<PageInfo>(`${base}/browsers/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: { pageId } }),
		startControl: (id: string, pageId: string) =>
			request<BrowserControlSession>(`${base}/browsers/${encodeURIComponent(id)}/control`, {
				method: 'POST',
				body: { pageId },
				signal: AbortSignal.timeout(10000)
			}),
		stopControl: (id: string, session: BrowserControlSession) =>
			request<{ completed: boolean }>(`${base}/browsers/${encodeURIComponent(id)}/control`, {
				method: 'DELETE',
				body: { pageId: session.pageId, sessionId: session.sessionId },
				keepalive: true,
				signal: AbortSignal.timeout(5000)
			}),
		input: (id: string, session: BrowserControlSession, sequence: number, events: BrowserInputEvent[]) =>
			request<BrowserInputResult>(`${base}/browsers/${encodeURIComponent(id)}/input`, {
				method: 'POST',
				body: { pageId: session.pageId, sessionId: session.sessionId, sequence, events },
				signal: AbortSignal.timeout(10000)
			}),
		navigate: (id: string, url: string, pageId?: string) =>
			request<PageInfo>(`${base}/browsers/${encodeURIComponent(id)}/navigate`, {
				method: 'POST',
				body: pageId ? { url, pageId } : { url }
			}),
		click: (id: string, selector: string, pageId?: string, framePath: string[] = []) =>
			request<{ completed: boolean }>(`${base}/browsers/${encodeURIComponent(id)}/click`, {
				method: 'POST',
				body: { selector, ...(pageId ? { pageId } : {}), ...(framePath.length ? { framePath } : {}) }
			}),
		fill: (id: string, selector: string, text: string, pageId?: string, framePath: string[] = []) =>
			request<{ completed: boolean }>(`${base}/browsers/${encodeURIComponent(id)}/fill`, {
				method: 'POST',
				body: { selector, text, ...(pageId ? { pageId } : {}), ...(framePath.length ? { framePath } : {}) }
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
	},

	/**
	 * Question bank administration. The gateway adds the internal service token;
	 * the browser never sees it. Query credentials are issued by /connections and
	 * are only used by the independent query probe in api/question-query.ts.
	 */
	questionBank: {
		status: (signal?: AbortSignal) => request<QuestionBankStatus>(`${base}/question-bank/status`, { signal }),
		settings: {
			get: (signal?: AbortSignal) => request<QuestionBankSettings>(`${base}/question-bank/settings`, { signal }),
			update: (
				patch: Partial<Omit<QuestionBankSettings, 'model'>> & { model?: Partial<QuestionBankModelConfig> },
				signal?: AbortSignal
			) => request<QuestionBankSettings>(`${base}/question-bank/settings`, { method: 'PATCH', body: patch, signal })
		},
		clients: {
			list: (signal?: AbortSignal) => request<QuestionBankClient[]>(`${base}/question-bank/tokens`, { signal }),
			remove: (id: string) =>
				request<void>(`${base}/question-bank/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
		},
		connections: {
			create: (name: string, baseUrl: string, signal?: AbortSignal) =>
				request<QuestionBankConnection>(`${base}/question-bank/connections`, {
					method: 'POST',
					body: { name, baseUrl },
					signal
				})
		},
		folders: {
			list: (signal?: AbortSignal) => request<QuestionBankFolder[]>(`${base}/question-bank/folders`, { signal }),
			create: (name: string, parentId: number) =>
				request<QuestionBankFolder>(`${base}/question-bank/folders`, { method: 'POST', body: { name, parentId } }),
			update: (id: number, name: string, parentId: number) =>
				request<QuestionBankFolder>(`${base}/question-bank/folders/${id}`, {
					method: 'PUT',
					body: { name, parentId }
				}),
			remove: (id: number) => request<void>(`${base}/question-bank/folders/${id}`, { method: 'DELETE' })
		},
		questions: {
			list: (params: { page: number; limit: number; folderId?: number | null; q?: string }, signal?: AbortSignal) => {
				const search = new URLSearchParams({ page: String(params.page), limit: String(params.limit) });
				if (typeof params.folderId === 'number') search.set('folderId', String(params.folderId));
				if (params.q) search.set('q', params.q);
				return request<QuestionBankQuestionPage>(`${base}/question-bank/questions?${search}`, { signal });
			},
			get: (id: number, signal?: AbortSignal) =>
				request<QuestionBankQuestion>(`${base}/question-bank/questions/${id}`, { signal }),
			create: (input: QuestionInput) =>
				request<QuestionBankQuestion>(`${base}/question-bank/questions`, { method: 'POST', body: input }),
			update: (id: number, input: QuestionInput) =>
				request<QuestionBankQuestion>(`${base}/question-bank/questions/${id}`, { method: 'PUT', body: input }),
			remove: (id: number) => request<void>(`${base}/question-bank/questions/${id}`, { method: 'DELETE' }),
			import: (questions: QuestionInput[], signal?: AbortSignal) =>
				request<QuestionBankImportResult>(`${base}/question-bank/questions/import`, {
					method: 'POST',
					body: { questions },
					signal
				})
		},
		logs: (limit = 100, signal?: AbortSignal) =>
			request<QuestionBankLog[]>(`${base}/question-bank/logs?limit=${limit}`, { signal })
	}
};
