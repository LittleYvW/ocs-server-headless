import { ApiError, currentBearer } from './client';
import type { ServiceEvent } from './types';

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'retrying' | 'paused' | 'denied';

export interface StreamHandlers {
	onEvent: (event: ServiceEvent) => void;
	onStatus: (status: StreamStatus, detail?: string) => void;
	onUnauthorized: () => void;
	onReconnect: () => void;
}

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

/**
 * Fetch-based SSE. EventSource cannot send the required Bearer header, and the
 * token must never be placed in a query string.
 */
export class EventStreamClient {
	private controller?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private watchdog?: ReturnType<typeof setTimeout>;
	private buffer = '';
	private attempts = 0;
	private lastEventId = 0;
	private hasConnected = false;
	private stopped = true;
	private paused = false;
	private retryOnAbort = false;

	constructor(private readonly handlers: StreamHandlers) {}

	start(): void {
		this.stopped = false;
		this.paused = false;
		this.attempts = 0;
		void this.connect();
	}

	pause(): void {
		if (this.stopped) return;
		this.paused = true;
		this.controller?.abort();
		// Drop the reference immediately so a fast resume() can start a new
		// request while the aborted one is still settling.
		this.controller = undefined;
		clearTimeout(this.timer);
		clearTimeout(this.watchdog);
		this.setStatus('paused');
	}

	resume(): void {
		if (this.stopped) {
			this.start();
			return;
		}
		this.paused = false;
		this.attempts = 0;
		this.setStatus('connecting');
		void this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.paused = false;
		this.controller?.abort();
		clearTimeout(this.timer);
		clearTimeout(this.watchdog);
		this.controller = undefined;
		this.buffer = '';
		this.lastEventId = 0;
		this.hasConnected = false;
		this.setStatus('idle');
	}

	private setStatus(status: StreamStatus, detail = ''): void {
		this.handlers.onStatus(status, detail);
	}

	private async connect(): Promise<void> {
		if (this.stopped || this.paused) return;
		if (this.controller) return;
		this.buffer = '';
		const controller = new AbortController();
		this.controller = controller;
		this.setStatus('connecting');
		try {
			const headers: Record<string, string> = { Accept: 'text/event-stream' };
			const token = currentBearer();
			if (token) headers.Authorization = `Bearer ${token}`;
			if (this.lastEventId) headers['Last-Event-ID'] = String(this.lastEventId);
			const response = await fetch(`${API_BASE}/api/v1/events`, {
				headers,
				signal: controller.signal,
				credentials: 'same-origin',
				cache: 'no-store'
			});
			if (response.status === 401 || response.status === 403) {
				this.setStatus('denied', response.status === 403 ? '来源未授权' : '认证已失效');
				this.handlers.onUnauthorized();
				return;
			}
			if (!response.ok)
				throw new ApiError(response.status, 'STREAM_ERROR', `事件流连接失败（HTTP ${response.status}）`);
			if (!response.body) throw new Error('事件流不可读');
			// A retry that finally succeeds must re-sync state, even if this is the
			// first successful connection of the page session.
			const recovered = this.hasConnected || this.attempts > 0;
			this.attempts = 0;
			this.setStatus('live');
			if (recovered) this.handlers.onReconnect();
			this.hasConnected = true;
			this.armWatchdog(controller);
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				this.armWatchdog(controller);
				this.buffer += decoder.decode(value, { stream: true });
				this.drain();
			}
			if (!this.stopped) this.schedule();
		} catch (error) {
			if (this.stopped) return;
			if ((error as DOMException | undefined)?.name === 'AbortError') {
				if (this.retryOnAbort) {
					this.retryOnAbort = false;
					this.schedule();
				}
				return;
			}
			if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
				this.setStatus('denied', error.message);
				this.handlers.onUnauthorized();
				return;
			}
			this.schedule(error instanceof Error ? error.message : '事件流中断');
		} finally {
			clearTimeout(this.watchdog);
			if (this.controller === controller) this.controller = undefined;
		}
	}

	private schedule(detail = ''): void {
		if (this.stopped || this.paused) return;
		clearTimeout(this.timer);
		const delay = Math.min(15000, 700 * 2 ** this.attempts) + Math.round(Math.random() * 350);
		this.attempts += 1;
		this.setStatus('retrying', detail);
		this.timer = setTimeout(() => void this.connect(), delay);
	}

	private armWatchdog(controller: AbortController): void {
		clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => {
			this.retryOnAbort = true;
			controller.abort();
		}, 45000);
	}

	private drain(): void {
		for (;;) {
			const match = /\r?\n\r?\n/.exec(this.buffer);
			if (!match || match.index === undefined) return;
			const raw = this.buffer.slice(0, match.index);
			this.buffer = this.buffer.slice(match.index + match[0].length);
			this.dispatch(raw);
		}
	}

	private dispatch(block: string): void {
		const data: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (!line || line.startsWith(':')) continue;
			const colon = line.indexOf(':');
			const field = colon === -1 ? line : line.slice(0, colon);
			let value = colon === -1 ? '' : line.slice(colon + 1);
			if (value.startsWith(' ')) value = value.slice(1);
			if (field === 'data') data.push(value);
		}
		if (!data.length) return;
		try {
			const event = JSON.parse(data.join('\n')) as ServiceEvent;
			if (typeof event.id !== 'number' || typeof event.type !== 'string') return;
			this.lastEventId = event.id;
			this.handlers.onEvent(event);
		} catch {
			// Ignore malformed frames; a new stream frame may still be valid.
		}
	}
}
