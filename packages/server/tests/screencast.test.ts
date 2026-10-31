import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Screencast } from '../src/screencast';

function fixture() {
	const session = Object.assign(new EventEmitter(), { send: vi.fn(async () => {}), detach: vi.fn(async () => {}) });
	const page = Object.assign(new EventEmitter(), {
		isClosed: () => false,
		context: () => ({ newCDPSession: async () => session })
	});
	return { session, page: page as any };
}

describe('CDP screencast transport', () => {
	it('sends one frame until the consumer acknowledges and discards excess frames', async () => {
		const { session, page } = fixture();
		const frames: any[] = [];
		const cast = new Screencast((frame) => frames.push(frame));
		await cast.start(page, 'page-1');
		expect(session.send).toHaveBeenCalledWith('Page.startScreencast', {
			format: 'jpeg',
			quality: 60,
			maxWidth: 1280,
			maxHeight: 720,
			everyNthFrame: 1
		});
		session.emit('Page.screencastFrame', { data: 'first', sessionId: 1 });
		session.emit('Page.screencastFrame', { data: 'discarded', sessionId: 2 });
		expect(frames).toHaveLength(1);
		expect(session.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 2 });
		await cast.acknowledge('unknown');
		expect(session.send).not.toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
		await cast.acknowledge(frames[0].frameId);
		expect(session.send).toHaveBeenCalledWith('Page.screencastFrameAck', { sessionId: 1 });
		session.emit('Page.screencastFrame', { data: 'next', sessionId: 3 });
		expect(frames).toHaveLength(2);
		expect(frames[1]).toMatchObject({ pageId: 'page-1', base64: 'next', contentType: 'image/jpeg' });
		await cast.stop();
		expect(session.send).toHaveBeenCalledWith('Page.stopScreencast');
		expect(session.detach).toHaveBeenCalledOnce();
		expect(session.listenerCount('Page.screencastFrame')).toBe(0);
	});
	it('bounds dimensions/quality and detaches on page close', async () => {
		const { session, page } = fixture();
		const cast = new Screencast(() => {});
		await expect(cast.start(page, 'page', { maxWidth: 100000 })).rejects.toThrow('Invalid screencast options');
		expect(session.send).not.toHaveBeenCalled();
		await cast.start(page, 'page', { quality: 80, maxWidth: 640, maxHeight: 480 });
		page.emit('close');
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.detach).toHaveBeenCalledOnce();
	});
});
