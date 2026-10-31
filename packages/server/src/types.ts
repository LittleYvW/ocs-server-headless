export interface BrowserProfile {
	id: string;
	name: string;
	group?: string;
	tags?: string[];
	notes?: string;
	startUrl: string;
	automationScripts: { name: string; configs: Record<string, unknown> }[];
	userScriptIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface UserScript {
	id: string;
	name: string;
	code: string;
	matches: string[];
	enabled: boolean;
	/** Missing on older databases: ordinary JavaScript injected by Playwright. */
	mode?: 'plain' | 'userscript';
	metadata?: UserScriptMetadata;
	sourceUrl?: string;
	version?: string;
	updateUrl?: string;
	pinned?: boolean;
	createdAt: string;
	updatedAt: string;
}

/** The original userscript header and all directives, including unknown ones. */
export interface UserScriptMetadata {
	raw: string;
	values: Record<string, string[]>;
}

export interface RuntimeState {
	id: string;
	status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
	pid?: number;
	error?: string;
	resources?: { memoryMB: number; cpuPercent: number; cpuTime: number; sampledAt: string };
}

export interface Database {
	version: 1;
	browsers: BrowserProfile[];
	userScripts: UserScript[];
	settings: { ocs: Record<string, unknown> };
}
