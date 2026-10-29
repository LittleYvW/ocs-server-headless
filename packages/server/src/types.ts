export interface BrowserProfile {
	id: string;
	name: string;
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
	createdAt: string;
	updatedAt: string;
}

export interface RuntimeState {
	id: string;
	status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
	pid?: number;
	error?: string;
}

export interface Database {
	version: 1;
	browsers: BrowserProfile[];
	userScripts: UserScript[];
	settings: { ocs: Record<string, unknown> };
}
