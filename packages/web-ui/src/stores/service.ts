import { reactive } from 'vue';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import type {
	AutomationDefinition,
	BrowserPayload,
	BrowserView,
	RuntimeState,
	SettingsPayload,
	SystemInfo,
	UserScript
} from '@/api/types';
import { toast } from './toasts';

export const service = reactive({
	system: null as SystemInfo | null,
	automation: [] as AutomationDefinition[],
	browsers: [] as BrowserView[],
	scripts: [] as UserScript[],
	settings: null as SettingsPayload | null,
	loading: false,
	syncedAt: ''
});

export type BrowserAction = 'start' | 'stop' | 'restart';
const pending = reactive<Record<string, BrowserAction | 'delete'>>({});

let generation = 0;

export function isPending(id: string): boolean {
	return !!pending[id];
}

export function browserById(id: string | undefined): BrowserView | undefined {
	return id ? service.browsers.find((item) => item.id === id) : undefined;
}

export function browserName(id: string): string {
	return browserById(id)?.name || id.slice(0, 8);
}

export async function loadAll(options: { quiet?: boolean } = {}): Promise<void> {
	const current = ++generation;
	service.loading = true;
	try {
		const [system, automation, browsers, scripts, settings] = await Promise.all([
			api.system(),
			api.automationScripts(),
			api.browsers.list(),
			api.scripts.list(),
			api.settings.get()
		]);
		if (current !== generation) return;
		service.system = system;
		service.automation = automation;
		service.browsers = browsers;
		service.scripts = scripts;
		service.settings = settings;
		service.syncedAt = new Date().toISOString();
	} catch (error) {
		if (current === generation && !options.quiet) toast(describeError(error), 'error');
	} finally {
		if (current === generation) service.loading = false;
	}
}

export async function refreshBrowsers(quiet = false): Promise<void> {
	try {
		service.browsers = await api.browsers.list();
	} catch (error) {
		if (!quiet) toast(describeError(error), 'error');
	}
}

export async function refreshScripts(quiet = false): Promise<void> {
	try {
		service.scripts = await api.scripts.list();
	} catch (error) {
		if (!quiet) toast(describeError(error), 'error');
	}
}

export async function refreshSettings(quiet = false): Promise<void> {
	try {
		service.settings = await api.settings.get();
	} catch (error) {
		if (!quiet) toast(describeError(error), 'error');
	}
}

export async function refreshSystem(quiet = false): Promise<void> {
	try {
		service.system = await api.system();
	} catch (error) {
		if (!quiet) toast(describeError(error), 'error');
	}
}

export function applyRuntime(id: string, runtime: RuntimeState): void {
	const browser = browserById(id);
	if (!browser) {
		scheduleBrowserRefresh();
		return;
	}
	browser.runtime = runtime;
}

export function upsertBrowser(browser: BrowserView): void {
	const index = service.browsers.findIndex((item) => item.id === browser.id);
	if (index === -1) service.browsers.push(browser);
	else service.browsers[index] = browser;
}

export async function saveBrowser(id: string | null, payload: BrowserPayload): Promise<BrowserView> {
	const saved = id ? await api.browsers.update(id, payload) : await api.browsers.create(payload);
	upsertBrowser(saved);
	return saved;
}

export async function removeBrowser(id: string): Promise<boolean> {
	const label = browserById(id)?.name || '实例';
	pending[id] = 'delete';
	try {
		await api.browsers.remove(id);
		service.browsers = service.browsers.filter((item) => item.id !== id);
		toast(`已删除「${label}」配置`, 'ok');
		return true;
	} catch (error) {
		toast(describeError(error), 'error');
		return false;
	} finally {
		delete pending[id];
	}
}

export async function runAction(id: string, action: BrowserAction): Promise<void> {
	if (pending[id]) return;
	pending[id] = action;
	const label = browserById(id)?.name || '实例';
	try {
		const runtime = await api.browsers.action(id, action);
		applyRuntime(id, runtime);
		const done = action === 'start' ? '已启动' : action === 'stop' ? '已停止' : '已重启';
		toast(`「${label}」${done}`, 'ok');
	} catch (error) {
		toast(describeError(error), 'error');
		void refreshBrowsers(true);
	} finally {
		delete pending[id];
	}
}

let browserTimer: ReturnType<typeof setTimeout> | undefined;
let scriptTimer: ReturnType<typeof setTimeout> | undefined;

export function scheduleBrowserRefresh(): void {
	clearTimeout(browserTimer);
	browserTimer = setTimeout(() => void refreshBrowsers(true), 300);
}

export function scheduleScriptRefresh(): void {
	clearTimeout(scriptTimer);
	scriptTimer = setTimeout(() => void refreshScripts(true), 300);
}

export function resetService(): void {
	generation += 1;
	service.system = null;
	service.automation = [];
	service.browsers = [];
	service.scripts = [];
	service.settings = null;
	service.loading = false;
	service.syncedAt = '';
}
