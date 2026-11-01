import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { ApiError, bad, fields, object, text } from './validation';
import { inspectBrowserElement, type BrowserElement } from './browser-target';

type Modifier = 'Alt' | 'Control' | 'ControlOrMeta' | 'Meta' | 'Shift';
export type BrowserInputEvent =
	| {
			type: 'click';
			x: number;
			y: number;
			button?: 'left' | 'middle' | 'right';
			clickCount?: number;
			modifiers?: Modifier[];
	  }
	| { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
	| { type: 'move'; x: number; y: number }
	| {
			type: 'pointer-down' | 'pointer-up';
			x: number;
			y: number;
			button?: 'left' | 'middle' | 'right';
			clickCount?: number;
			modifiers?: Modifier[];
	  }
	| { type: 'pointer-cancel' }
	| { type: 'inspect'; x: number; y: number; requestId: number }
	| { type: 'key'; key: string; modifiers?: Modifier[] }
	| { type: 'text'; text: string };

export interface BrowserInputBatch {
	pageId: string;
	sessionId: string;
	sequence: number;
	events: BrowserInputEvent[];
}

const modifiers = ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'];
const specialKeys = new Set([
	'Backspace',
	'Tab',
	'Enter',
	'Escape',
	'Delete',
	'Insert',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'ArrowLeft',
	'ArrowRight',
	'ArrowUp',
	'ArrowDown',
	'Space'
]);

/** Validate at both the HTTP and worker boundaries. Never forward an arbitrary Playwright method. */
export function browserInputBatch(value: unknown): BrowserInputBatch {
	const body = object(value);
	fields(body, ['pageId', 'sessionId', 'sequence', 'events']);
	text(body.pageId, 'pageId', 100);
	text(body.sessionId, 'sessionId', 100);
	if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) bad('Invalid input sequence');
	if (!Array.isArray(body.events) || body.events.length > 32) bad('Expected at most 32 input events');
	for (const value of body.events) {
		const event = object(value);
		const allowed = ['click', 'pointer-down', 'pointer-up'].includes(event.type)
			? ['x', 'y', 'button', 'clickCount', 'modifiers']
			: event.type === 'move'
			? ['x', 'y']
			: event.type === 'pointer-cancel'
			? []
			: event.type === 'inspect'
			? ['x', 'y', 'requestId']
			: event.type === 'wheel'
			? ['x', 'y', 'deltaX', 'deltaY']
			: event.type === 'key'
			? ['key', 'modifiers']
			: event.type === 'text'
			? ['text']
			: undefined;
		if (!allowed) throw new ApiError(400, 'INVALID_REQUEST', 'Unsupported input event');
		fields(event, ['type', ...allowed]);
		if (['click', 'wheel', 'move', 'pointer-down', 'pointer-up', 'inspect'].includes(event.type)) {
			for (const coordinate of [event.x, event.y]) {
				if (typeof coordinate !== 'number' || !Number.isFinite(coordinate) || coordinate < 0 || coordinate >= 1)
					bad('Expected viewport coordinates in [0, 1)');
			}
		}
		if (['click', 'pointer-down', 'pointer-up'].includes(event.type)) {
			if (event.button !== undefined && !['left', 'middle', 'right'].includes(event.button))
				bad('Invalid mouse button');
			if (event.clickCount !== undefined && ![1, 2].includes(event.clickCount)) bad('Invalid click count');
		}
		if (event.type === 'inspect' && (!Number.isSafeInteger(event.requestId) || event.requestId < 1))
			bad('Invalid inspection request ID');
		if (event.type === 'wheel') {
			for (const delta of [event.deltaX, event.deltaY]) {
				if (typeof delta !== 'number' || !Number.isFinite(delta) || Math.abs(delta) > 10000) bad('Invalid wheel delta');
			}
		}
		if (
			event.modifiers !== undefined &&
			(!Array.isArray(event.modifiers) ||
				event.modifiers.length > 4 ||
				new Set(event.modifiers).size !== event.modifiers.length ||
				event.modifiers.some((key: unknown) => !modifiers.includes(key as string)))
		)
			bad('Invalid key modifiers');
		if (
			event.type === 'key' &&
			(typeof event.key !== 'string' ||
				!(
					/^[\x20-\x7e]$/.test(event.key) ||
					/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/.test(event.key) ||
					specialKeys.has(event.key)
				))
		)
			bad('Unsupported key');
		if (event.type === 'text' && (typeof event.text !== 'string' || !event.text.length || event.text.length > 10000))
			bad('Expected 1 to 10000 text characters');
	}
	return body as BrowserInputBatch;
}

interface ControlSession {
	id: string;
	pageId: string;
	page: Page;
	viewport: { width: number; height: number };
	sequence: number;
	timer?: ReturnType<typeof setTimeout>;
	onClose: () => void;
	button?: 'left' | 'middle' | 'right';
	clickCount?: number;
	modifiers?: Modifier[];
}

/** A single, expiring controller per instance. Only input uses this bounded serial queue. */
export class BrowserInput {
	private current?: ControlSession;
	private tail: Promise<unknown> = Promise.resolve();
	private pending = 0;

	constructor(private automationBusy: (page: Page) => boolean = () => false, private leaseMs = 15000) {}

	private enqueue<T>(run: () => Promise<T>, bounded = true): Promise<T> {
		if (bounded && this.pending >= 32) return Promise.reject(new ApiError(429, 'INPUT_BUSY', 'Input queue is full'));
		this.pending++;
		const result = this.tail.then(run);
		this.tail = result
			.catch(() => {})
			.finally(() => {
				this.pending--;
			});
		return result;
	}

	private renew(session: ControlSession): void {
		clearTimeout(session.timer);
		session.timer = setTimeout(() => {
			void this.stop(session.pageId, session.id).catch(() => {});
		}, this.leaseMs);
		session.timer.unref();
	}

	start(page: Page, pageId: string) {
		return this.enqueue(async () => {
			if (this.current) throw new ApiError(409, 'CONTROL_BUSY', 'Another control session is active');
			if (this.automationBusy(page)) throw new ApiError(409, 'AUTOMATION_BUSY', 'Automation is running on this page');
			const viewport = page.viewportSize();
			if (!viewport || page.isClosed()) throw new ApiError(404, 'PAGE_NOT_FOUND', 'Page is unavailable');
			const session: ControlSession = {
				id: randomUUID(),
				pageId,
				page,
				viewport,
				sequence: 0,
				onClose: () => {
					void this.stop(pageId, session.id).catch(() => {});
				}
			};
			this.current = session;
			page.once('close', session.onClose);
			this.renew(session);
			return { sessionId: session.id, pageId, viewport, leaseMs: this.leaseMs };
		});
	}

	stop(pageId?: string, sessionId?: string): Promise<{ completed: boolean }> {
		const session = this.current;
		if (
			!session ||
			(pageId !== undefined && pageId !== session.pageId) ||
			(sessionId !== undefined && sessionId !== session.id)
		)
			return Promise.resolve({ completed: true });
		// Invalidate immediately, including batches that are waiting behind an in-flight operation.
		this.current = undefined;
		clearTimeout(session.timer);
		session.page.off('close', session.onClose);
		return this.enqueue(async () => {
			await this.releaseKeys(session);
			return { completed: true };
		}, false);
	}

	private async releaseKeys(session: ControlSession): Promise<void> {
		const page = session.page;
		// End a held gesture at its last position; moving it during cleanup would change sliders or selections.
		if (session.button) {
			await page.mouse.up({ button: session.button }).catch(() => {});
		}
		// An unsolicited middle-button up can paste the primary selection on Linux.
		// Atomic click/key operations release themselves; clean up only this session's held state.
		for (const key of session.modifiers || []) await page.keyboard.up(key).catch(() => {});
		session.button = undefined;
		session.modifiers = undefined;
	}

	submit(value: unknown): Promise<{
		completed: boolean;
		sequence: number;
		inspections?: { requestId: number; element: BrowserElement | null }[];
	}> {
		const batch = browserInputBatch(value);
		const session = this.current;
		return this.enqueue(async () => {
			if (!session || this.current !== session || batch.sessionId !== session.id || batch.pageId !== session.pageId)
				throw new ApiError(409, 'CONTROL_EXPIRED', 'Control session has ended');
			if (batch.sequence === session.sequence) return { completed: true, sequence: session.sequence };
			if (batch.sequence !== session.sequence + 1)
				throw new ApiError(409, 'INPUT_OUT_OF_ORDER', 'Input sequence is out of order');
			const viewport = session.page.viewportSize();
			if (!viewport || viewport.width !== session.viewport.width || viewport.height !== session.viewport.height)
				throw new ApiError(409, 'CONTROL_VIEW_CHANGED', 'Viewport has changed; reconnect control');
			if (this.automationBusy(session.page))
				throw new ApiError(409, 'AUTOMATION_BUSY', 'Automation is running on this page');
			// Reserve before executing: a partially completed batch must never be replayed.
			session.sequence = batch.sequence;
			this.renew(session);
			const inspections: { requestId: number; element: BrowserElement | null }[] = [];
			try {
				for (const event of batch.events) {
					if (this.current !== session) throw new ApiError(409, 'CONTROL_EXPIRED', 'Control session has ended');
					if (session.button && !['move', 'pointer-up', 'pointer-cancel'].includes(event.type))
						throw new ApiError(409, 'INPUT_INVALID_STATE', 'Release the pointer before another operation');
					if (event.type === 'inspect') {
						const element = await inspectBrowserElement(
							session.page,
							event.x * session.viewport.width,
							event.y * session.viewport.height
						);
						inspections.push({ requestId: event.requestId, element });
						continue;
					}
					await this.apply(session, event);
				}
			} catch (error) {
				// Schedule cleanup after this batch, without waiting on our own queue.
				void this.stop(session.pageId, session.id).catch(() => {});
				throw error;
			}
			return { completed: true, sequence: batch.sequence, ...(inspections.length ? { inspections } : {}) };
		});
	}

	private async apply(session: ControlSession, event: BrowserInputEvent): Promise<void> {
		const page = session.page;
		if (event.type === 'pointer-cancel') {
			if (session.button) await this.releaseKeys(session);
			else await page.mouse.move(-1, -1);
			return;
		}
		if (event.type === 'inspect') return;
		if (event.type === 'text') {
			await page.keyboard.insertText(event.text);
			return;
		}
		if (event.type === 'key') {
			try {
				await page.keyboard.press([...(event.modifiers || []), event.key].join('+'));
			} finally {
				for (const key of event.modifiers || []) await page.keyboard.up(key).catch(() => {});
			}
			return;
		}
		const x = event.x * session.viewport.width;
		const y = event.y * session.viewport.height;
		if (event.type === 'move') {
			await page.mouse.move(x, y, session.button ? { steps: 2 } : {});
			return;
		}
		if (event.type === 'pointer-down') {
			if (session.button) throw new ApiError(409, 'INPUT_INVALID_STATE', 'A pointer is already held');
			session.button = event.button || 'left';
			session.clickCount = event.clickCount || 1;
			session.modifiers = event.modifiers || [];
			await page.mouse.move(x, y);
			for (const key of session.modifiers) await page.keyboard.down(key);
			await page.mouse.down({ button: session.button, clickCount: session.clickCount });
			return;
		}
		if (event.type === 'pointer-up') {
			if (!session.button || session.button !== (event.button || 'left'))
				throw new ApiError(409, 'INPUT_INVALID_STATE', 'No matching pointer is held');
			await page.mouse.move(x, y, { steps: 2 });
			await page.mouse.up({ button: session.button, clickCount: session.clickCount });
			for (const key of session.modifiers || []) await page.keyboard.up(key);
			session.button = undefined;
			session.modifiers = undefined;
			return;
		}
		if (event.type === 'wheel') {
			await page.mouse.move(x, y);
			await page.mouse.wheel(event.deltaX, event.deltaY);
			return;
		}
		try {
			for (const key of event.modifiers || []) await page.keyboard.down(key);
			await page.mouse.click(x, y, { button: event.button, clickCount: event.clickCount });
		} finally {
			for (const key of event.modifiers || []) await page.keyboard.up(key).catch(() => {});
		}
	}
}
