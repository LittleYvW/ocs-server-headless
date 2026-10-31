import type { BrowserInputEvent } from '@/api/types';

/** One HTTP batch in flight, including heartbeats. A failed batch is never replayed. */
export class InputChannel {
	private events: BrowserInputEvent[] = [];
	private sequence = 0;
	private sending = false;
	private stopped = false;
	private scheduled = false;

	constructor(
		private send: (sequence: number, events: BrowserInputEvent[]) => Promise<unknown>,
		private failure: (error: unknown) => void
	) {}

	stop(): void {
		this.stopped = true;
		this.events = [];
	}

	push(event: BrowserInputEvent): void {
		if (this.stopped) return;
		const previous = this.events[this.events.length - 1];
		if (event.type === 'wheel' && previous?.type === 'wheel') {
			previous.x = event.x;
			previous.y = event.y;
			previous.deltaX = Math.max(-10000, Math.min(10000, previous.deltaX + event.deltaX));
			previous.deltaY = Math.max(-10000, Math.min(10000, previous.deltaY + event.deltaY));
		} else this.events.push(event);
		if (this.events.length > 128) {
			this.fail(new Error('操作积压，请重新开启直接操作。'));
			return;
		}
		if (!this.scheduled) {
			this.scheduled = true;
			queueMicrotask(() => {
				this.scheduled = false;
				void this.flush();
			});
		}
	}

	heartbeat(): void {
		void this.flush(true);
	}

	private fail(error: unknown): void {
		if (this.stopped) return;
		this.stop();
		this.failure(error);
	}

	private async flush(heartbeat = false): Promise<void> {
		if (this.stopped || this.sending || (!heartbeat && !this.events.length)) return;
		this.sending = true;
		try {
			await this.send(++this.sequence, this.events.splice(0, 32));
		} catch (error) {
			this.fail(error);
		} finally {
			this.sending = false;
			if (this.events.length) void this.flush();
		}
	}
}
