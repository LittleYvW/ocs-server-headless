import { randomUUID } from 'node:crypto';
import type { CDPSession, Page } from 'playwright-core';

export interface ScreencastFrame {
	frameId: string;
	pageId: string;
	base64: string;
	contentType: 'image/jpeg';
	timestamp: number;
}

export interface ScreencastOptions {
	maxWidth?: number;
	maxHeight?: number;
	quality?: number;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
		throw new Error('Invalid screencast options');
	return value;
}

/** One unconsumed worker frame at a time. The HTTP consumer must acknowledge or stop the session. */
export class Screencast {
	private generation = 0;
	private active?: {
		session: CDPSession;
		page: Page;
		pending?: { frameId: string; sessionId: number };
		onClose: () => void;
		onFrame: (frame: { data: string; sessionId: number }) => void;
	};

	constructor(
		private onFrame: (frame: ScreencastFrame) => void,
		private onEnded: (pageId: string) => void = () => {}
	) {}

	async start(page: Page, pageId: string, options: ScreencastOptions = {}): Promise<void> {
		const settings = {
			format: 'jpeg' as const,
			quality: integer(options.quality, 60, 1, 90),
			maxWidth: integer(options.maxWidth, 1280, 64, 1920),
			maxHeight: integer(options.maxHeight, 720, 64, 1080),
			everyNthFrame: 1
		};
		await this.stop();
		const generation = ++this.generation;
		const session = await page.context().newCDPSession(page);
		if (generation !== this.generation || page.isClosed()) {
			await session.detach().catch(() => {});
			return;
		}
		const active = {
			session,
			page,
			pending: undefined as { frameId: string; sessionId: number } | undefined,
			onClose: () => {
				void this.stop();
				this.onEnded(pageId);
			},
			onFrame: (_frame: { data: string; sessionId: number }) => {}
		};
		this.active = active;
		page.once('close', active.onClose);
		active.onFrame = (frame: { data: string; sessionId: number }) => {
			if (this.active !== active) return;
			if (active.pending || typeof frame.data !== 'string' || frame.data.length > 2 * 1024 * 1024) {
				void session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
				return;
			}
			const frameId = randomUUID();
			active.pending = { frameId, sessionId: frame.sessionId };
			this.onFrame({ frameId, pageId, base64: frame.data, contentType: 'image/jpeg', timestamp: Date.now() });
		};
		session.on('Page.screencastFrame', active.onFrame);
		try {
			await session.send('Page.startScreencast', settings);
		} catch (error) {
			if (this.active === active) await this.stop();
			throw error;
		}
	}

	async acknowledge(frameId: unknown): Promise<void> {
		const active = this.active;
		if (!active?.pending || active.pending.frameId !== frameId) return;
		const sessionId = active.pending.sessionId;
		active.pending = undefined;
		await active.session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
	}

	async stop(): Promise<void> {
		++this.generation;
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		active.page.off('close', active.onClose);
		active.session.off('Page.screencastFrame', active.onFrame);
		await active.session.send('Page.stopScreencast').catch(() => {});
		await active.session.detach().catch(() => {});
	}
}
