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

export interface BrowserOptions {
	locale?: string;
	timezoneId?: string;
	userAgent?: string;
	viewport?: { width: number; height: number };
}

export interface BrowserProfile {
	id: string;
	name: string;
	group?: string;
	tags?: string[];
	notes?: string;
	startUrl: string;
	browserOptions?: BrowserOptions;
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
	resources?: { memoryMB: number; cpuPercent: number; cpuTime: number; sampledAt: string };
}

export interface BrowserView extends BrowserProfile {
	runtime: RuntimeState;
}

export interface UserScript {
	pinned?: boolean;
	id: string;
	name: string;
	code: string;
	matches: string[];
	enabled: boolean;
	mode?: 'plain' | 'userscript';
	metadata?: { raw: string; values: Record<string, string[]> };
	sourceUrl?: string;
	version?: string;
	updateUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PageInfo {
	id: string;
	url: string;
	title: string;
	automationRunning?: boolean;
}

export interface BrowserControlSession {
	sessionId: string;
	pageId: string;
	viewport: { width: number; height: number };
	leaseMs: number;
}

export type InputModifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
export type BrowserInputEvent =
	| {
			type: 'click';
			x: number;
			y: number;
			button?: 'left' | 'middle' | 'right';
			clickCount?: number;
			modifiers?: InputModifier[];
	  }
	| { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
	| { type: 'move'; x: number; y: number }
	| {
			type: 'pointer-down' | 'pointer-up';
			x: number;
			y: number;
			button?: 'left' | 'middle' | 'right';
			clickCount?: number;
			modifiers?: InputModifier[];
	  }
	| { type: 'pointer-cancel' }
	| { type: 'inspect'; x: number; y: number; requestId: number }
	| { type: 'key'; key: string; modifiers?: InputModifier[] }
	| { type: 'text'; text: string };

export interface BrowserElement {
	selector: string;
	framePath: string[];
	tag: string;
	bounds: { x: number; y: number; width: number; height: number };
}

export interface BrowserInputResult {
	completed: boolean;
	sequence: number;
	inspections?: { requestId: number; element: BrowserElement | null }[];
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
	ocrAvailable?: boolean;
	maxBrowsers: number;
	browsers: RuntimeState[];
	capabilities: string[];
	resources?: {
		totalMemoryMB: number;
		freeMemoryMB: number;
		cpuCount: number;
		loadAverage: number[];
		cpuPercent?: number;
	};
	resourcePolicy?: { minFreeMemoryMB?: number; maxCpuPercent?: number };
}

export interface BrowserStorage {
	profileBytes: number;
	downloadBytes: number;
	cacheBytes: number;
}

export type StorageTarget = 'cache' | 'profile' | 'downloads' | 'all';

export interface DataImportSummary {
	browsers: number;
	userScripts: number;
	warnings: string[];
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
	group?: string;
	tags?: string[];
	notes?: string;
	startUrl: string;
	browserOptions?: BrowserOptions;
	automationScripts: AutomationEntry[];
	userScriptIds: string[];
}

export interface ScriptPayload {
	pinned?: boolean;
	name: string;
	code: string;
	matches?: string[];
	enabled: boolean;
	mode?: 'plain' | 'userscript';
	sourceUrl?: string;
	updateUrl?: string;
}

export interface ScriptUpdateCheck {
	available: boolean;
	currentVersion: string | null;
	latestVersion: string | null;
	updateUrl: string;
}

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

/** Question bank service: mirrors the admin API proxied by /api/v1/question-bank. */
export type QuestionBankProtocol = 'openai-chat' | 'openai-response';

export interface QuestionBankModelConfig {
	protocol: QuestionBankProtocol;
	baseUrl: string;
	modelId: string;
	/** '***' while a key is stored; an empty string clears it. Never persisted locally. */
	apiKey: string;
}

export interface QuestionBankSettings {
	enabled: boolean;
	aiEnabled: boolean;
	autoCache: boolean;
	sameQuestionCheck: boolean;
	timeoutSeconds: number;
	retryCount: number;
	model: QuestionBankModelConfig;
}

export interface QuestionBankLimits {
	maxConcurrent: number;
	perTokenConcurrent: number;
	perTokenPerMinute: number;
	timeoutSeconds: number;
}

export interface QuestionBankStats {
	questions: number;
	tokens: number;
}

export interface QuestionBankStatus {
	configured: boolean;
	available: boolean;
	enabled?: boolean;
	aiEnabled?: boolean;
	service?: string;
	version?: string;
	stats?: QuestionBankStats;
	limits?: QuestionBankLimits;
	capabilities?: string[];
}

export interface QuestionBankFolder {
	id: number;
	name: string;
	parentId: number;
	/** Direct children only; a folder subtree is not summed. */
	questionCount: number;
}

export interface QuestionBankQuestion {
	id: number;
	question: string;
	options?: string | null;
	answer: string;
	questionType?: string | null;
	folderId: number;
	isAi: boolean;
	isPendingCorrection: boolean;
	/** SQLite 'YYYY-MM-DD HH:mm:ss' in UTC. */
	createdAt?: string | null;
}

export interface QuestionInput {
	question: string;
	options?: string | null;
	answer: string;
	questionType?: string | null;
	folderId?: number;
	isAi?: boolean;
	isPendingCorrection?: boolean;
}

export interface QuestionBankQuestionPage {
	items: QuestionBankQuestion[];
	total: number;
	page: number;
	limit: number;
}

export interface QuestionBankClient {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt?: string | null;
}

export interface QuestionBankConnection {
	client: QuestionBankClient & { token: string };
	queryUrl: string;
	wrapper: unknown[];
}

export interface QuestionBankImportResult {
	inserted: number;
	skipped: number;
}

export interface QuestionBankLog {
	id: string;
	/** SQLite 'YYYY-MM-DD HH:mm:ss' in UTC. */
	timestamp: string;
	tokenId: string;
	status: number;
	durationMs: number;
	/** 'local' | 'ai-or-cache' | 'error' */
	source: string;
	errorCode?: string | null;
}

export interface QuestionQueryPayload {
	title: string;
	options?: string;
	type?: string;
}

export interface QuestionQueryData {
	id: number;
	question: string;
	answer: string;
	is_ai: boolean;
	is_pending_correction: boolean;
}
