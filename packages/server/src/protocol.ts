import type { BrowserProfile, UserScript } from './types';

export type BrowserAction = 'pages' | 'navigate' | 'screenshot' | 'click' | 'fill';

export interface WorkerStart {
	profile: BrowserProfile;
	scripts: UserScript[];
	dataDir: string;
	executablePath?: string;
	extensions: string[];
}

export type WorkerRequest = {
	id: string;
	action: BrowserAction | 'start' | 'stop';
	payload?: any;
};

export type WorkerResponse =
	| { id: string; ok: true; result?: any }
	| { id: string; ok: false; error: string; code: string; status: number }
	| { event: string; data: Record<string, unknown> };
