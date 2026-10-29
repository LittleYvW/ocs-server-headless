import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { BrowserProfile, RuntimeState, UserScript } from './types';
import type { BrowserAction, WorkerRequest, WorkerResponse } from './protocol';

export type { RuntimeState } from './types';

export interface RuntimeOptions {
	dataDir: string;
	executablePath?: string;
	maxBrowsers: number;
	extensions: string[];
	/** Keep the Linux data lock alive until browser workers have also exited. */
	lockDescriptor?: number;
	/** Dependency injection for process lifecycle tests; never supplied by the API. */
	workerPath?: string;
	startupTimeoutMs?: number;
	commandTimeoutMs?: number;
	stopTimeoutMs?: number;
}

export class RuntimeError extends Error {
	constructor(message: string, public status = 409, public code = 'RUNTIME_ERROR') {
		super(message);
	}
}

type Pending = {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type Instance = {
	state: RuntimeState;
	child?: ChildProcess;
	pending: Map<string, Pending>;
	start?: Promise<RuntimeState>;
	stop?: Promise<RuntimeState>;
	exited?: Promise<void>;
	resolveExit?: () => void;
};

/** Owns every worker independently of HTTP clients and frontend connections. */
export class Runtime {
	private instances = new Map<string, Instance>();
	private closing = false;

	constructor(private options: RuntimeOptions, private onEvent: (type: string, data: unknown) => void) {}

	list(): RuntimeState[] {
		return [...this.instances.values()].map((entry) => ({ ...entry.state }));
	}

	get(id: string): RuntimeState {
		return { ...(this.instances.get(id)?.state || { id, status: 'stopped' }) };
	}

	async start(profile: BrowserProfile, scripts: UserScript[]): Promise<RuntimeState> {
		if (this.closing) throw new RuntimeError('Service is shutting down', 503, 'SHUTTING_DOWN');
		if (!/^[a-zA-Z0-9_-]{1,100}$/.test(profile.id)) {
			throw new RuntimeError('Invalid browser ID', 400, 'INVALID_ID');
		}
		const previous = this.instances.get(profile.id);
		if (previous?.child || previous?.state.status === 'starting' || previous?.state.status === 'stopping') {
			throw new RuntimeError('Browser is already active', 409, 'BROWSER_BUSY');
		}
		const active = [...this.instances.values()].filter((item) => item.child || item.state.status === 'starting');
		if (active.length >= this.options.maxBrowsers) {
			throw new RuntimeError('Maximum browser concurrency reached', 409, 'BROWSER_LIMIT');
		}
		const entry: Instance = { state: { id: profile.id, status: 'starting' }, pending: new Map() };
		this.instances.set(profile.id, entry);
		this.publish(entry);
		entry.start = this.launch(entry, profile, scripts);
		return entry.start;
	}

	private async launch(entry: Instance, profile: BrowserProfile, scripts: UserScript[]): Promise<RuntimeState> {
		try {
			mkdirSync(path.join(this.options.dataDir, 'profiles', profile.id), { recursive: true, mode: 0o700 });
			const child = fork(this.options.workerPath || path.join(__dirname, 'worker.js'), [], {
				stdio:
					this.options.lockDescriptor === undefined
						? ['ignore', 'ignore', 'ignore', 'ipc']
						: ['ignore', 'ignore', 'ignore', 'ipc', this.options.lockDescriptor],
				detached: process.platform !== 'win32',
				// Do not pass API tokens or encryption keys to browser workers.
				env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('OCS_')))
			});
			entry.child = child;
			entry.state.pid = child.pid;
			entry.exited = new Promise<void>((resolve) => (entry.resolveExit = resolve));
			child.on('message', (message: WorkerResponse) => this.receive(entry, message));
			child.once('error', () => this.failed(entry, 'Browser worker could not start'));
			// close also fires when spawning fails before an exit event exists.
			child.once('close', () => this.exited(entry));
			await this.request(
				entry,
				'start',
				{
					profile,
					scripts,
					dataDir: this.options.dataDir,
					executablePath: this.options.executablePath,
					extensions: this.options.extensions
				},
				this.options.startupTimeoutMs || 60000
			);
			if (entry.state.status !== 'starting' || !entry.child) {
				throw new RuntimeError('Browser startup was cancelled', 409, 'START_CANCELLED');
			}
			entry.state.status = 'running';
			this.publish(entry);
			return { ...entry.state };
		} catch (error) {
			if (entry.state.status !== 'stopping' && entry.state.status !== 'stopped') {
				this.failed(entry, 'Browser startup failed; check browser installation and dependencies');
				await this.terminate(entry);
			}
			throw error instanceof RuntimeError
				? error
				: new RuntimeError('Browser startup failed; check browser installation and dependencies', 502, 'START_FAILED');
		}
	}

	async stop(id: string): Promise<RuntimeState> {
		const entry = this.instances.get(id);
		if (!entry) return { id, status: 'stopped' };
		if (entry.stop) return entry.stop;
		if (!entry.child) return { ...entry.state };
		entry.state.status = 'stopping';
		this.publish(entry);
		entry.stop = (async () => {
			this.rejectPending(entry, new RuntimeError('Browser is stopping', 409, 'BROWSER_STOPPING'));
			await this.terminate(entry);
			entry.state = { id, status: 'stopped' };
			this.publish(entry);
			return { ...entry.state };
		})();
		try {
			return await entry.stop;
		} finally {
			entry.stop = undefined;
		}
	}

	async restart(profile: BrowserProfile, scripts: UserScript[]): Promise<RuntimeState> {
		await this.stop(profile.id);
		return this.start(profile, scripts);
	}

	async command(id: string, action: BrowserAction, payload: any = {}): Promise<any> {
		const entry = this.instances.get(id);
		if (!entry || entry.state.status !== 'running' || !entry.child) {
			throw new RuntimeError('Browser is not running', 409, 'BROWSER_NOT_RUNNING');
		}
		if (!['pages', 'navigate', 'screenshot', 'click', 'fill'].includes(action)) {
			throw new RuntimeError('Unsupported browser action', 400, 'INVALID_ACTION');
		}
		return this.request(entry, action, payload, this.options.commandTimeoutMs || 35000);
	}

	async close(): Promise<void> {
		this.closing = true;
		await Promise.all([...this.instances.keys()].map((id) => this.stop(id)));
	}

	private request(entry: Instance, action: WorkerRequest['action'], payload: any, timeout: number): Promise<any> {
		return new Promise((resolve, reject) => {
			const child = entry.child;
			if (!child?.connected) {
				reject(new RuntimeError('Browser worker is unavailable', 503, 'WORKER_UNAVAILABLE'));
				return;
			}
			const id = randomUUID();
			const timer = setTimeout(() => {
				entry.pending.delete(id);
				reject(new RuntimeError('Browser operation timed out', 504, 'BROWSER_TIMEOUT'));
			}, timeout);
			entry.pending.set(id, { resolve, reject, timer });
			child.send({ id, action, payload }, (error) => {
				if (!error) return;
				const pending = entry.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				entry.pending.delete(id);
				pending.reject(new RuntimeError('Browser worker is unavailable', 503, 'WORKER_UNAVAILABLE'));
			});
		});
	}

	private receive(entry: Instance, message: WorkerResponse) {
		if (!message || typeof message !== 'object') return;
		if ('event' in message) {
			this.onEvent(message.event, { ...message.data, profileId: entry.state.id });
			return;
		}
		const pending = entry.pending.get(message.id);
		if (!pending) return;
		clearTimeout(pending.timer);
		entry.pending.delete(message.id);
		if (message.ok) pending.resolve(message.result);
		else pending.reject(new RuntimeError(message.error, message.status, message.code));
	}

	private publish(entry: Instance) {
		this.onEvent('browser-state', { profileId: entry.state.id, ...entry.state });
	}

	private failed(entry: Instance, error: string) {
		if (entry.state.status === 'stopping' || entry.state.status === 'stopped') return;
		entry.state.status = 'error';
		entry.state.error = error;
		this.rejectPending(entry, new RuntimeError(error, 502, 'WORKER_FAILED'));
		this.publish(entry);
	}

	private exited(entry: Instance) {
		entry.child = undefined;
		delete entry.state.pid;
		if (entry.state.status === 'stopping') entry.state.status = 'stopped';
		else if (entry.state.status !== 'error') this.failed(entry, 'Browser worker exited unexpectedly');
		this.rejectPending(entry, new RuntimeError('Browser worker exited', 502, 'WORKER_EXITED'));
		entry.resolveExit?.();
		this.publish(entry);
	}

	private rejectPending(entry: Instance, error: Error) {
		for (const pending of entry.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		entry.pending.clear();
	}

	private async terminate(entry: Instance) {
		const child = entry.child;
		if (!child) return;
		const timeout = this.options.stopTimeoutMs || 7000;
		if (child.connected) child.send({ id: randomUUID(), action: 'stop' }, () => {});
		else child.kill('SIGTERM');
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([entry.exited, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeout)))]);
		if (timer) clearTimeout(timer);
		if (entry.child) {
			try {
				if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
				else child.kill('SIGKILL');
			} catch {
				child.kill('SIGKILL');
			}
			await entry.exited;
		}
	}
}
