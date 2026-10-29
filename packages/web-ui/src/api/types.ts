/** Mirrors packages/server/src/types.ts and the documented /api/v1 shapes. */
export type RuntimeStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

export type ApiFailureCode =
	| 'UNAUTHORIZED'
	| 'ORIGIN_DENIED'
	| 'INVALID_REQUEST'
	| 'INVALID_JSON'
	| 'NOT_FOUND'
	| 'BROWSER_BUSY'
	| 'BROWSER_LIMIT'
	| 'BROWSER_NOT_RUNNING'
	| 'BROWSER_OPERATION_FAILED'
	| 'BROWSER_TIMEOUT'
	| 'PAGE_NOT_FOUND'
	| 'SCRIPT_IN_USE'
	| 'LIMIT_REACHED'
	| 'BODY_TOO_LARGE'
	| 'NETWORK_ERROR'
	| 'INTERNAL_ERROR';

/** Mirrors packages/common automation Config. Imported shape is enforced where consumed. */
export type ConfigType = 'text' | 'password' | 'number' | 'textarea' | 'select' | 'switch' | 'url';

export interface ConfigOption {
	label: string;
	value: unknown;
}

export interface ConfigDefinition {
	label: string;
	value: unknown;
	hide?: boolean;
	visibleWhen?: { key: string; value: unknown };
	type?: ConfigType;
	required?: boolean;
	max?: number;
	min?: number;
	options?: ConfigOption[];
	placeholder?: string;
	pattern?: string;
	patternMessage?: string;
}

export interface AutomationDefinition {
	name: string;
	icon?: string;
	configs: Record<string, ConfigDefinition>;
	needOCR: boolean;
}

export interface AutomationEntry {
	name: string;
	configs: Record<string, unknown>;
}

export interface BrowserProfile {
	id: string;
	name: string;
	startUrl: string;
	automationScripts: AutomationEntry[];
	userScriptIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface RuntimeState {
	id: string;
	status: RuntimeStatus;
	pid?: number;
	error?: string;
}

export interface BrowserView extends BrowserProfile {
	runtime: RuntimeState;
}

export interface UserScript {
	id: string;
	name: string;
	code: string;
	matches: string[];
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface PageInfo {
	id: string;
	url: string;
	title: string;
}

export interface DownloadItem {
	filename: string;
	size: number;
}

export interface SystemInfo {
	name: string;
	apiVersion: number;
	node: string;
	platform: string;
	headless: boolean;
	maxBrowsers: number;
	browsers: RuntimeState[];
	capabilities: string[];
}

export interface SettingsPayload {
	ocs: Record<string, unknown>;
}

export interface ServiceEvent<T = unknown> {
	id: number;
	type: string;
	time: string;
	data: T;
}

export interface BrowserPayload {
	name: string;
	startUrl: string;
	automationScripts: AutomationEntry[];
	userScriptIds: string[];
}

export interface ScriptPayload {
	name: string;
	code: string;
	matches: string[];
	enabled: boolean;
}
