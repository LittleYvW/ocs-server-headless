import { computed, reactive } from 'vue';
import { ApiError } from '@/api/client';
import { api } from '@/api/endpoints';
import {
	describeBankError,
	planImportBatches,
	utf8Bytes,
	validateQuestionInput,
	hasFieldErrors
} from '@/lib/question-bank';
import type {
	QuestionBankClient,
	QuestionBankConnection,
	QuestionBankFolder,
	QuestionBankImportResult,
	QuestionBankLog,
	QuestionBankModelConfig,
	QuestionBankQuestion,
	QuestionBankSettings,
	QuestionBankStatus,
	QuestionInput
} from '@/api/types';
import { toast } from './toasts';

/**
 * Question-bank page state.
 *
 * Rules that shape this store:
 * - Status is polled every 10s only while the page is mounted and visible.
 * - Every read is cancellable; page/query switches abort the previous list
 *   request so an older response cannot overwrite newer filters.
 * - Model API keys and query tokens live only in this module's memory. They are
 *   never written to storage, URLs, toasts or console output.
 * - A failed status read keeps the previous snapshot but marks it stale instead
 *   of pretending the service is healthy.
 */

export const bank = reactive({
	status: null as QuestionBankStatus | null,
	statusAt: '',
	statusError: '',
	statusLoading: false,
	statusPending: false,

	settings: null as QuestionBankSettings | null,
	draft: null as QuestionBankSettings | null,
	settingsLoading: false,
	settingsSaving: false,
	settingsError: '',
	keyEditing: false,
	keyValue: '',
	keyCleared: false,

	folders: [] as QuestionBankFolder[],
	foldersLoading: false,

	questions: [] as QuestionBankQuestion[],
	questionsTotal: 0,
	questionsPage: 1,
	questionsLimit: 20,
	/** null means "all folders"; 0 is the protected default folder. */
	questionsFolder: null as number | null,
	questionsQuery: '',
	questionsLoading: false,
	questionsError: '',
	questionsAt: '',

	clients: [] as QuestionBankClient[],
	clientsLoading: false,
	clientsError: '',
	connecting: false,
	connection: null as QuestionBankConnection | null,

	logs: [] as QuestionBankLog[],
	logsLoading: false,
	logsError: '',
	logsAt: '',
	logsVisible: false
});

export const configured = computed(() => bank.status?.configured !== false);
export const available = computed(() => bank.status?.available === true);
export const queryEnabled = computed(() => bank.status?.enabled === true);
export const aiEnabled = computed(() => bank.status?.aiEnabled === true);
export const storedKey = computed(() => bank.settings?.model.apiKey === '***');

const SETTINGS_POLL_MS = 10_000;

let pollTimer: ReturnType<typeof setInterval> | undefined;
let active = false;
let visit = 0;
let questionToken = 0;
let questionDebounce: ReturnType<typeof setTimeout> | undefined;
const inflight = new Map<string, AbortController>();

function track(key: string): AbortController {
	inflight.get(key)?.abort();
	const controller = new AbortController();
	inflight.set(key, controller);
	return controller;
}

function release(key: string, controller: AbortController): void {
	if (inflight.get(key) === controller) inflight.delete(key);
}

function current(key: string, controller: AbortController): boolean {
	return active && !controller.signal.aborted && inflight.get(key) === controller;
}

function aborted(error: unknown): boolean {
	return error instanceof DOMException && error.name === 'AbortError';
}

function stopAll(): void {
	for (const controller of inflight.values()) controller.abort();
	inflight.clear();
}

/* — Status ———————————————————————————————————————————— */

export async function refreshStatus(quiet = false): Promise<void> {
	if (!active) return;
	bank.statusLoading = true;
	const controller = track('status');
	try {
		const status = await api.questionBank.status(controller.signal);
		if (!current('status', controller)) return;
		bank.status = status;
		bank.statusAt = new Date().toISOString();
		bank.statusError = '';
	} catch (error) {
		if (aborted(error) || !current('status', controller)) return;
		// Keep the last snapshot visible, but never report it as live.
		bank.statusError = describeBankError(error);
		if (!quiet) toast(bank.statusError, 'error');
	} finally {
		if (current('status', controller)) bank.statusLoading = false;
		release('status', controller);
	}
}

async function pollTick(): Promise<void> {
	if (!active || document.hidden) return;
	await refreshStatus(true);
	if (bank.logsVisible && available.value) void loadLogs(true);
}

async function toggleQuery(enabled: boolean): Promise<boolean> {
	if (!active || bank.statusPending) return false;
	bank.statusPending = true;
	const controller = track('toggle');
	try {
		const updated = await api.questionBank.settings.update({ enabled }, controller.signal);
		if (!current('toggle', controller)) return false;
		if (bank.status) bank.status = { ...bank.status, enabled: updated.enabled };
		if (bank.settings) bank.settings.enabled = updated.enabled;
		if (bank.draft) bank.draft.enabled = updated.enabled;
		toast(updated.enabled ? '查询入口已启用' : '查询入口已暂停', 'ok');
		return true;
	} catch (error) {
		if (aborted(error) || !current('toggle', controller)) return false;
		toast(describeBankError(error), 'error');
		await refreshStatus(true);
		return false;
	} finally {
		if (current('toggle', controller)) bank.statusPending = false;
		release('toggle', controller);
	}
}

export { toggleQuery };

/* — Lifecycle —————————————————————————————————————————— */

export async function openBank(): Promise<void> {
	if (active) return;
	active = true;
	const opened = visit;
	document.addEventListener('visibilitychange', onVisibility);
	pollTimer = setInterval(() => void pollTick(), SETTINGS_POLL_MS);
	await refreshStatus();
	if (!active || opened !== visit || !configured.value || !available.value) return;
	await Promise.all([loadSettings(), loadFolders(), loadQuestions()]);
	void loadClients();
}

export function closeBank(): void {
	active = false;
	visit += 1;
	if (pollTimer) clearInterval(pollTimer);
	pollTimer = undefined;
	clearTimeout(questionDebounce);
	questionDebounce = undefined;
	document.removeEventListener('visibilitychange', onVisibility);
	stopAll();
	questionToken += 1;
	// Query tokens only ever existed in memory for this visit.
	bank.connection = null;
	bank.keyEditing = false;
	bank.keyValue = '';
	bank.keyCleared = false;
	bank.settingsError = '';
	bank.logsVisible = false;
}

function onVisibility(): void {
	if (!document.hidden && active) void pollTick();
}

/* — Settings ————————————————————————————————————————— */

function cloneSettings(settings: QuestionBankSettings): QuestionBankSettings {
	return {
		enabled: settings.enabled,
		aiEnabled: settings.aiEnabled,
		autoCache: settings.autoCache,
		sameQuestionCheck: settings.sameQuestionCheck,
		timeoutSeconds: settings.timeoutSeconds,
		retryCount: settings.retryCount,
		model: {
			protocol: settings.model.protocol,
			baseUrl: settings.model.baseUrl,
			modelId: settings.model.modelId,
			apiKey: settings.model.apiKey
		}
	};
}

function resetDraft(): void {
	bank.draft = bank.settings ? cloneSettings(bank.settings) : null;
	bank.keyEditing = false;
	bank.keyValue = '';
	bank.keyCleared = false;
}

export async function loadSettings(): Promise<void> {
	if (!active) return;
	bank.settingsLoading = true;
	const controller = track('settings');
	try {
		const settings = await api.questionBank.settings.get(controller.signal);
		if (!current('settings', controller)) return;
		const dirty = settingsDirty.value;
		bank.settings = settings;
		// A dirty draft survives external refreshes.
		if (!dirty) resetDraft();
	} catch (error) {
		if (aborted(error) || !current('settings', controller)) return;
		bank.settingsError = describeBankError(error);
	} finally {
		if (current('settings', controller)) bank.settingsLoading = false;
		release('settings', controller);
	}
}

function signature(settings: QuestionBankSettings): string {
	return JSON.stringify({
		enabled: settings.enabled,
		aiEnabled: settings.aiEnabled,
		autoCache: settings.autoCache,
		sameQuestionCheck: settings.sameQuestionCheck,
		timeoutSeconds: settings.timeoutSeconds,
		retryCount: settings.retryCount,
		model: {
			protocol: settings.model.protocol,
			baseUrl: settings.model.baseUrl,
			modelId: settings.model.modelId
		}
	});
}

export const settingsDirty = computed(() => {
	if (!bank.settings || !bank.draft) return false;
	if (bank.keyEditing || bank.keyCleared) return true;
	return signature(bank.draft) !== signature(bank.settings);
});

export function editKey(): void {
	bank.keyEditing = true;
	bank.keyCleared = false;
	bank.keyValue = '';
}

export function cancelKeyEdit(): void {
	bank.keyEditing = false;
	bank.keyValue = '';
	bank.keyCleared = false;
}

export function clearKey(): void {
	bank.keyEditing = false;
	bank.keyValue = '';
	bank.keyCleared = true;
}

export function restoreSettingsDraft(): void {
	resetDraft();
	bank.settingsError = '';
}

function baseUrlProblem(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '';
	if (trimmed.length > 2000) return 'Base URL 不能超过 2000 个字符。';
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return 'Base URL 不是合法地址。';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Base URL 只支持 http 或 https。';
	if (parsed.username || parsed.password) return 'Base URL 不能包含账号或密码。';
	if (parsed.search || parsed.hash) return 'Base URL 不能包含查询参数或片段。';
	return '';
}

export function validateDraft(): string {
	const draft = bank.draft;
	if (!draft) return '尚未读取设置。';
	if (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 5 || draft.timeoutSeconds > 55)
		return '总超时必须是 5–55 之间的整数秒。';
	if (!Number.isInteger(draft.retryCount) || draft.retryCount < 0 || draft.retryCount > 2)
		return '重试次数必须是 0–2。';
	const urlError = baseUrlProblem(draft.model.baseUrl);
	if (urlError) return urlError;
	if (draft.model.modelId.length > 200) return '模型 ID 不能超过 200 个字符。';
	if (bank.keyValue.length > 4096) return 'API Key 过长。';
	if (/[\u0000-\u001f\u007f]/.test(bank.keyValue)) return 'API Key 不能包含控制字符。';
	if (draft.aiEnabled && (!draft.model.baseUrl.trim() || !draft.model.modelId.trim()))
		return '开启 AI 需要先填写 Base URL 与模型 ID。';
	return '';
}

type SettingsPatch = Partial<Omit<QuestionBankSettings, 'model'>> & { model?: Partial<QuestionBankModelConfig> };

function buildPatch(): SettingsPatch | null {
	const draft = bank.draft;
	const current = bank.settings;
	if (!draft || !current) return null;
	const patch: SettingsPatch = {};
	if (draft.enabled !== current.enabled) patch.enabled = draft.enabled;
	if (draft.aiEnabled !== current.aiEnabled) patch.aiEnabled = draft.aiEnabled;
	if (draft.autoCache !== current.autoCache) patch.autoCache = draft.autoCache;
	if (draft.sameQuestionCheck !== current.sameQuestionCheck) patch.sameQuestionCheck = draft.sameQuestionCheck;
	if (draft.timeoutSeconds !== current.timeoutSeconds) patch.timeoutSeconds = draft.timeoutSeconds;
	if (draft.retryCount !== current.retryCount) patch.retryCount = draft.retryCount;
	const model: Partial<QuestionBankModelConfig> = {};
	if (draft.model.protocol !== current.model.protocol) model.protocol = draft.model.protocol;
	if (draft.model.baseUrl.trim() !== current.model.baseUrl) model.baseUrl = draft.model.baseUrl.trim();
	if (draft.model.modelId.trim() !== current.model.modelId) model.modelId = draft.model.modelId.trim();
	if (bank.keyEditing) model.apiKey = bank.keyValue;
	else if (bank.keyCleared && current.model.apiKey) model.apiKey = '';
	if (Object.keys(model).length > 0) patch.model = model;
	return Object.keys(patch).length > 0 ? patch : null;
}

export async function saveSettings(): Promise<boolean> {
	if (!active || bank.settingsSaving) return false;
	const problem = validateDraft();
	if (problem) {
		bank.settingsError = problem;
		return false;
	}
	const patch = buildPatch();
	if (!patch) {
		bank.settingsError = '';
		return true;
	}
	bank.settingsSaving = true;
	bank.settingsError = '';
	const controller = track('save-settings');
	try {
		const updated = await api.questionBank.settings.update(patch, controller.signal);
		if (!current('save-settings', controller)) return false;
		bank.settings = updated;
		resetDraft();
		if (bank.status) bank.status = { ...bank.status, enabled: updated.enabled, aiEnabled: updated.aiEnabled };
		toast('题库设置已保存', 'ok');
		return true;
	} catch (error) {
		if (aborted(error) || !current('save-settings', controller)) return false;
		// Keep the draft so the user can correct the rejected values.
		bank.settingsError = describeBankError(error);
		return false;
	} finally {
		if (current('save-settings', controller)) bank.settingsSaving = false;
		release('save-settings', controller);
	}
}

/* — Folders ——————————————————————————————————————————— */

export async function loadFolders(): Promise<void> {
	if (!active) return;
	bank.foldersLoading = true;
	const controller = track('folders');
	try {
		const folders = await api.questionBank.folders.list(controller.signal);
		if (!current('folders', controller)) return;
		bank.folders = folders;
	} catch (error) {
		if (!aborted(error) && current('folders', controller)) bank.questionsError = describeBankError(error);
	} finally {
		if (current('folders', controller)) bank.foldersLoading = false;
		release('folders', controller);
	}
}

export async function createFolder(name: string, parentId: number): Promise<boolean> {
	try {
		await api.questionBank.folders.create(name.trim(), parentId);
		await loadFolders();
		void refreshStatus(true);
		toast('文件夹已创建', 'ok');
		return true;
	} catch (error) {
		toast(describeBankError(error), 'error');
		return false;
	}
}

export async function renameFolder(id: number, name: string, parentId: number): Promise<boolean> {
	try {
		await api.questionBank.folders.update(id, name.trim(), parentId);
		await loadFolders();
		toast('文件夹已更新', 'ok');
		return true;
	} catch (error) {
		toast(describeBankError(error), 'error');
		return false;
	}
}

export async function deleteFolder(id: number): Promise<boolean> {
	try {
		await api.questionBank.folders.remove(id);
		await loadFolders();
		if (bank.questionsFolder === id) await setQuestionFolder(null);
		toast('文件夹已删除', 'ok');
		return true;
	} catch (error) {
		toast(describeBankError(error), 'error');
		return false;
	}
}

/* — Questions ————————————————————————————————————————— */

export function totalPages(): number {
	return Math.max(1, Math.ceil(bank.questionsTotal / bank.questionsLimit));
}

export async function loadQuestions(quiet = false): Promise<void> {
	if (!active) return;
	const token = ++questionToken;
	bank.questionsLoading = true;
	const controller = track('questions');
	try {
		const page = await api.questionBank.questions.list(
			{
				page: bank.questionsPage,
				limit: bank.questionsLimit,
				folderId: bank.questionsFolder,
				q: bank.questionsQuery.trim()
			},
			controller.signal
		);
		if (token !== questionToken) return;
		bank.questions = page.items;
		bank.questionsTotal = page.total;
		bank.questionsAt = new Date().toISOString();
		bank.questionsError = '';
		// A stale page (for example after deleting the last row) falls back once.
		const pages = Math.max(1, Math.ceil(page.total / bank.questionsLimit));
		if (bank.questionsPage > pages) {
			bank.questionsPage = pages;
			await loadQuestions(true);
		}
	} catch (error) {
		if (aborted(error) || token !== questionToken) return;
		bank.questionsError = describeBankError(error);
		if (!quiet) toast(bank.questionsError, 'error');
	} finally {
		if (token === questionToken) release('questions', controller);
		if (token === questionToken) bank.questionsLoading = false;
	}
}

export function setQuestionFolder(folderId: number | null): Promise<void> {
	bank.questionsFolder = folderId;
	bank.questionsPage = 1;
	return loadQuestions();
}

export function setQuestionPage(page: number): Promise<void> {
	const pages = totalPages();
	const next = Math.min(Math.max(1, Math.trunc(page)), pages);
	if (next === bank.questionsPage) return Promise.resolve();
	bank.questionsPage = next;
	return loadQuestions();
}

export function setQuestionLimit(limit: number): Promise<void> {
	bank.questionsLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
	bank.questionsPage = 1;
	return loadQuestions();
}

/** Search is debounced and always restarts at page 1. */
export function setQuestionQuery(query: string): void {
	bank.questionsQuery = query;
	clearTimeout(questionDebounce);
	questionDebounce = setTimeout(() => {
		bank.questionsPage = 1;
		void loadQuestions();
	}, 280);
}

export async function refreshQuestion(id: number): Promise<QuestionBankQuestion | null> {
	if (!active) return null;
	const controller = track('question-detail');
	try {
		const record = await api.questionBank.questions.get(id, controller.signal);
		if (!current('question-detail', controller)) return null;
		const index = bank.questions.findIndex((item) => item.id === id);
		if (index !== -1) bank.questions[index] = record;
		return record;
	} catch (error) {
		if (!aborted(error) && current('question-detail', controller)) toast(describeBankError(error), 'error');
		return null;
	} finally {
		release('question-detail', controller);
	}
}

export async function saveQuestion(id: number | null, input: QuestionInput): Promise<QuestionBankQuestion> {
	const errors = validateQuestionInput(input);
	if (hasFieldErrors(errors)) {
		const first = Object.values(errors)[0] as string;
		throw new Error(first);
	}
	const saved =
		id === null ? await api.questionBank.questions.create(input) : await api.questionBank.questions.update(id, input);
	await Promise.all([loadQuestions(true), loadFolders()]);
	void refreshStatus(true);
	return saved;
}

export async function deleteQuestion(id: number): Promise<boolean> {
	try {
		await api.questionBank.questions.remove(id);
		const lastOnPage = bank.questions.length === 1 && bank.questionsPage > 1;
		if (lastOnPage) bank.questionsPage -= 1;
		await Promise.all([loadQuestions(true), loadFolders()]);
		void refreshStatus(true);
		toast('题目已删除', 'ok');
		return true;
	} catch (error) {
		toast(describeBankError(error), 'error');
		await loadQuestions(true);
		return false;
	}
}

/* — Clients ————————————————————————————————————————— */

export async function loadClients(): Promise<void> {
	if (!active) return;
	bank.clientsLoading = true;
	const controller = track('clients');
	try {
		const clients = await api.questionBank.clients.list(controller.signal);
		if (!current('clients', controller)) return;
		bank.clients = clients;
		bank.clientsError = '';
	} catch (error) {
		if (!aborted(error) && current('clients', controller)) bank.clientsError = describeBankError(error);
	} finally {
		if (current('clients', controller)) bank.clientsLoading = false;
		release('clients', controller);
	}
}

export async function createConnection(name: string, baseUrl: string): Promise<boolean> {
	if (!active || bank.connecting) return false;
	bank.connecting = true;
	bank.clientsError = '';
	const controller = track('connection');
	try {
		const connection = await api.questionBank.connections.create(name.trim(), baseUrl.trim(), controller.signal);
		if (!current('connection', controller)) return false;
		bank.connection = connection;
		await Promise.all([loadClients(), refreshStatus(true)]);
		return true;
	} catch (error) {
		if (aborted(error) || !current('connection', controller)) return false;
		bank.clientsError = describeBankError(error);
		return false;
	} finally {
		if (current('connection', controller)) bank.connecting = false;
		release('connection', controller);
	}
}

export function dismissConnection(): void {
	bank.connection = null;
}

export async function revokeClient(id: string): Promise<boolean> {
	try {
		await api.questionBank.clients.remove(id);
		bank.clients = bank.clients.filter((client) => client.id !== id);
		if (bank.connection?.client.id === id) bank.connection = null;
		await refreshStatus(true);
		toast('查询客户端已撤销，后续请求将返回 401', 'ok');
		return true;
	} catch (error) {
		toast(describeBankError(error), 'error');
		return false;
	}
}

/* — Logs ————————————————————————————————————————————— */

export async function loadLogs(quiet = false): Promise<void> {
	if (!active) return;
	bank.logsLoading = true;
	const controller = track('logs');
	try {
		const logs = await api.questionBank.logs(100, controller.signal);
		if (!current('logs', controller)) return;
		bank.logs = logs;
		bank.logsAt = new Date().toISOString();
		bank.logsError = '';
	} catch (error) {
		if (!aborted(error) && current('logs', controller)) {
			bank.logsError = describeBankError(error);
			if (!quiet) toast(bank.logsError, 'error');
		}
	} finally {
		if (current('logs', controller)) bank.logsLoading = false;
		release('logs', controller);
	}
}

export function setLogsVisible(visible: boolean): void {
	bank.logsVisible = visible;
}

/* — Import ——————————————————————————————————————————— */

export interface ImportBatchOutcome {
	index: number;
	count: number;
	ok: boolean;
	inserted: number;
	skipped: number;
	error?: string;
}

export interface ImportOutcome {
	batches: ImportBatchOutcome[];
	inserted: number;
	skipped: number;
	stopped: boolean;
}

/** Sequential batches: the first failure stops the run, earlier batches stay. */
export async function importQuestions(
	items: QuestionInput[],
	onProgress?: (done: number, total: number) => void
): Promise<ImportOutcome> {
	const plan = planImportBatches(items);
	const outcome: ImportOutcome = { batches: [], inserted: 0, skipped: 0, stopped: false };
	if (!active) return { ...outcome, stopped: true };
	const controller = track('import');
	try {
		for (let index = 0; index < plan.batches.length; index += 1) {
			if (!current('import', controller)) {
				outcome.stopped = true;
				break;
			}
			const batch = plan.batches[index];
			onProgress?.(index, plan.batches.length);
			try {
				const result: QuestionBankImportResult = await api.questionBank.questions.import(
					batch.items,
					controller.signal
				);
				outcome.inserted += result.inserted;
				outcome.skipped += result.skipped;
				outcome.batches.push({
					index,
					count: batch.items.length,
					ok: true,
					inserted: result.inserted,
					skipped: result.skipped
				});
			} catch (error) {
				outcome.batches.push({
					index,
					count: batch.items.length,
					ok: false,
					inserted: 0,
					skipped: 0,
					error: aborted(error) ? '导入等待已取消，当前批次是否完成请刷新题库确认。' : describeBankError(error)
				});
				outcome.stopped = true;
				break;
			}
		}
		if (current('import', controller)) {
			onProgress?.(Math.min(outcome.batches.length, plan.batches.length), plan.batches.length);
			await Promise.all([loadQuestions(true), loadFolders()]);
			await refreshStatus(true);
		}
		return outcome;
	} finally {
		release('import', controller);
	}
}

export function retryItemsFrom(outcome: ImportOutcome, items: QuestionInput[]): QuestionInput[] {
	const failed = outcome.batches.find((batch) => !batch.ok);
	if (!failed) return [];
	const plan = planImportBatches(items);
	return plan.batches.slice(failed.index).flatMap((batch) => batch.items);
}

/* — Reset ————————————————————————————————————————————— */

export function resetBank(): void {
	closeBank();
	bank.statusLoading = false;
	bank.statusPending = false;
	bank.settingsLoading = false;
	bank.settingsSaving = false;
	bank.foldersLoading = false;
	bank.questionsLoading = false;
	bank.clientsLoading = false;
	bank.connecting = false;
	bank.logsLoading = false;
	bank.status = null;
	bank.statusAt = '';
	bank.statusError = '';
	bank.settings = null;
	bank.draft = null;
	bank.settingsError = '';
	bank.folders = [];
	bank.questions = [];
	bank.questionsTotal = 0;
	bank.questionsPage = 1;
	bank.questionsQuery = '';
	bank.questionsError = '';
	bank.clients = [];
	bank.clientsError = '';
	bank.connection = null;
	bank.logs = [];
	bank.logsError = '';
	bank.logsAt = '';
}

export function apiErrorMessage(error: unknown): string {
	return error instanceof ApiError ? describeBankError(error) : error instanceof Error ? error.message : '操作失败。';
}

export function remainingBytes(used: number, limit: number): number {
	return Math.max(0, limit - used);
}

export function measure(value: string): number {
	return utf8Bytes(value);
}
