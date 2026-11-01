import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserInput, browserInputBatch } from '../src/browser-input';

function fixture() {
	const page = Object.assign(new EventEmitter(), {
		viewportSize: () => ({ width: 1365, height: 900 }),
		isClosed: () => false,
		keyboard: {
			insertText: vi.fn(async (_text: string) => {}),
			press: vi.fn(async () => {}),
			down: vi.fn(async () => {}),
			up: vi.fn(async () => {})
		},
		mouse: {
			click: vi.fn(async () => {}),
			down: vi.fn(async () => {}),
			move: vi.fn(async () => {}),
			wheel: vi.fn(async () => {}),
			up: vi.fn(async () => {})
		}
	});
	return page;
}

afterEach(() => vi.useRealTimers());

describe('direct browser input', () => {
	it('keeps a held pointer and modifiers across batches, then releases them in order', async () => {
		const page = fixture();
		const input = new BrowserInput();
		const { pageId, sessionId } = await input.start(page as any, 'drag');
		try {
			await input.submit({
				pageId,
				sessionId,
				sequence: 1,
				events: [{ type: 'pointer-down', x: 0.1, y: 0.2, modifiers: ['Shift'] }]
			});
			expect(page.mouse.down).toHaveBeenCalledWith({ button: 'left', clickCount: 1 });
			expect(page.keyboard.up).not.toHaveBeenCalled();
			await input.submit({ pageId, sessionId, sequence: 2, events: [{ type: 'move', x: 0.5, y: 0.4 }] });
			expect(page.mouse.move).toHaveBeenLastCalledWith(682.5, 360, { steps: 2 });
			await input.submit({ pageId, sessionId, sequence: 3, events: [{ type: 'pointer-up', x: 0.7, y: 0.4 }] });
			expect(page.mouse.up).toHaveBeenCalledWith({ button: 'left', clickCount: 1 });
			expect(page.keyboard.up).toHaveBeenCalledWith('Shift');
			await input.submit({ pageId, sessionId, sequence: 4, events: [{ type: 'text', text: 'after release' }] });
			expect(page.keyboard.insertText).toHaveBeenCalledWith('after release');
		} finally {
			await input.stop();
		}
	});

	it('releases a held pointer without moving it on lost ownership and accepts a fresh session', async () => {
		const page = fixture();
		const input = new BrowserInput();
		const first = await input.start(page as any, 'drag');
		await input.submit({
			pageId: first.pageId,
			sessionId: first.sessionId,
			sequence: 1,
			events: [{ type: 'pointer-down', x: 0.5, y: 0.5 }]
		});
		await input.stop(first.pageId, first.sessionId);
		expect(page.mouse.move).toHaveBeenLastCalledWith(682.5, 450);
		expect(page.mouse.up).toHaveBeenCalledWith({ button: 'left' });
		const next = await input.start(page as any, 'next');
		await expect(
			input.submit({
				pageId: next.pageId,
				sessionId: next.sessionId,
				sequence: 1,
				events: [{ type: 'pointer-up', x: 0.5, y: 0.5 }]
			})
		).rejects.toMatchObject({ code: 'INPUT_INVALID_STATE' });
		await input.stop();
	});
	it('maps normalized image coordinates to viewport CSS pixels and supports text, keys and wheels', async () => {
		const page = fixture();
		const input = new BrowserInput();
		const session = await input.start(page as any, 'page-one');
		try {
			await input.submit({
				pageId: session.pageId,
				sessionId: session.sessionId,
				sequence: 1,
				events: [
					{ type: 'click', x: 0.5, y: 0.25, modifiers: ['Shift'] },
					{ type: 'text', text: '中文输入' },
					{ type: 'key', key: 'KeyA', modifiers: ['ControlOrMeta'] },
					{ type: 'wheel', x: 0.1, y: 0.2, deltaX: 0, deltaY: 240 }
				]
			});
			expect(page.mouse.click).toHaveBeenCalledWith(682.5, 225, { button: undefined, clickCount: undefined });
			expect(page.keyboard.insertText).toHaveBeenCalledWith('中文输入');
			expect(page.keyboard.press).toHaveBeenCalledWith('ControlOrMeta+KeyA');
			expect(page.keyboard.up).toHaveBeenCalledWith('Shift');
			expect(page.keyboard.up).toHaveBeenCalledWith('ControlOrMeta');
			expect(page.mouse.move).toHaveBeenCalledWith(136.5, 180);
			expect(page.mouse.wheel).toHaveBeenCalledWith(0, 240);
		} finally {
			await input.stop();
		}
	});

	it('serializes concurrent batches and acknowledges duplicates without typing twice', async () => {
		const page = fixture();
		let unblock!: () => void;
		page.keyboard.insertText.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				})
		);
		const input = new BrowserInput();
		const { pageId, sessionId } = await input.start(page as any, 'first');
		const send = (sequence: number, text: string) =>
			input.submit({ pageId, sessionId, sequence, events: [{ type: 'text', text }] });
		try {
			await expect(send(2, 'wrong-order')).rejects.toMatchObject({ code: 'INPUT_OUT_OF_ORDER' });
			const first = send(1, 'first');
			const second = send(2, 'second');
			await vi.waitFor(() => expect(page.keyboard.insertText).toHaveBeenCalledTimes(1));
			unblock();
			await Promise.all([first, second]);
			await send(2, 'duplicate');
			expect(page.keyboard.insertText.mock.calls.map(([value]) => value)).toEqual(['first', 'second']);
			await expect(input.submit({ pageId: 'other', sessionId, sequence: 3, events: [] })).rejects.toMatchObject({
				code: 'CONTROL_EXPIRED'
			});
		} finally {
			await input.stop();
		}
	});

	it('cancels queued input on release and keeps an old release from stopping a new page session', async () => {
		const page = fixture();
		let unblock!: () => void;
		page.keyboard.insertText.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				})
		);
		const input = new BrowserInput();
		const { pageId, sessionId } = await input.start(page as any, 'first');
		const first = input.submit({ pageId, sessionId, sequence: 1, events: [{ type: 'text', text: 'in-flight' }] });
		await vi.waitFor(() => expect(page.keyboard.insertText).toHaveBeenCalledTimes(1));
		const queued = expect(
			input.submit({ pageId, sessionId, sequence: 2, events: [{ type: 'text', text: 'discard' }] })
		).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' });
		const stopped = input.stop(pageId, sessionId);
		unblock();
		await Promise.all([first, queued, stopped]);
		const next = await input.start(page as any, 'second');
		await input.stop(pageId, sessionId);
		await input.submit({ pageId: next.pageId, sessionId: next.sessionId, sequence: 1, events: [] });
		expect(page.keyboard.insertText).toHaveBeenCalledTimes(1);
		await input.stop();
	});

	it('expires abandoned control sessions, rejects competing owners and releases on page close', async () => {
		vi.useFakeTimers();
		const page = fixture();
		const input = new BrowserInput(() => false, 150);
		const first = await input.start(page as any, 'first');
		await input.submit({
			pageId: first.pageId,
			sessionId: first.sessionId,
			sequence: 1,
			events: [{ type: 'pointer-down', x: 0.5, y: 0.5 }]
		});
		await expect(input.start(page as any, 'second')).rejects.toMatchObject({ code: 'CONTROL_BUSY' });
		await vi.advanceTimersByTimeAsync(151);
		await expect(
			input.submit({ pageId: first.pageId, sessionId: first.sessionId, sequence: 1, events: [] })
		).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' });
		expect(page.mouse.up).toHaveBeenCalledTimes(1);
		expect(page.mouse.up).not.toHaveBeenCalledWith({ button: 'middle' });
		expect(page.mouse.move).toHaveBeenLastCalledWith(682.5, 450);
		const second = await input.start(page as any, 'second');
		page.emit('close');
		await expect(
			input.submit({ pageId: second.pageId, sessionId: second.sessionId, sequence: 1, events: [] })
		).rejects.toMatchObject({ code: 'CONTROL_EXPIRED' });
	});
	it('does not synthesize unheld buttons or modifiers when a viewer releases control', async () => {
		const page = fixture();
		const input = new BrowserInput();
		const session = await input.start(page as any, 'readonly');
		await input.stop(session.pageId, session.sessionId);
		expect(page.mouse.up).not.toHaveBeenCalled();
		expect(page.keyboard.up).not.toHaveBeenCalled();
	});

	it('rejects changing viewports and pages controlled by built-in automation', async () => {
		const page = fixture();
		let busy = true;
		const input = new BrowserInput(() => busy);
		await expect(input.start(page as any, 'first')).rejects.toMatchObject({ code: 'AUTOMATION_BUSY' });
		busy = false;
		const { pageId, sessionId } = await input.start(page as any, 'first');
		page.viewportSize = () => ({ width: 800, height: 600 });
		await expect(
			input.submit({ pageId, sessionId, sequence: 1, events: [{ type: 'click', x: 0.5, y: 0.5 }] })
		).rejects.toMatchObject({ code: 'CONTROL_VIEW_CHANGED' });
		expect(page.mouse.click).not.toHaveBeenCalled();
		await input.stop();
	});

	it('validates the complete event batch before any operation executes', () => {
		const batch = { pageId: 'page', sessionId: 'session', sequence: 1, events: [] as unknown[] };
		for (const event of [
			{ type: 'click', x: 1, y: 0 },
			{ type: 'pointer-down', x: 0, y: 1 },
			{ type: 'pointer-up', x: 0, y: 0, button: 'unknown' },
			{ type: 'move', x: Infinity, y: 0 },
			{ type: 'pointer-cancel', x: 0 },
			{ type: 'inspect', x: 0, y: 0, requestId: -1 },
			{ type: 'click', x: -0.1, y: 0.5 },
			{ type: 'wheel', x: 0, y: 0, deltaX: NaN, deltaY: 0 },
			{ type: 'text', text: 'x'.repeat(10001) },
			{ type: 'evaluate', code: 'process.env' },
			{ type: 'key', key: 'KeyA', modifiers: ['Control', 'Control'] },
			{ type: 'click', x: 0, y: 0, path: '/private' }
		])
			expect(() => browserInputBatch({ ...batch, events: [event] })).toThrow();
		expect(() => browserInputBatch({ ...batch, events: Array(33).fill({ type: 'text', text: 'x' }) })).toThrow();
		expect(() => browserInputBatch({ ...batch, sequence: 0 })).toThrow();
		expect(browserInputBatch(batch)).toEqual(batch);
	});
});
