import { reactive } from 'vue';
import { api } from '@/api/endpoints';
import type { RuntimeState, ServiceEvent } from '@/api/types';
import { EventStreamClient, type StreamStatus } from '@/api/stream';
import { expireSession } from './session';
import { applyRuntime, loadAll, refreshSettings, scheduleBrowserRefresh, scheduleScriptRefresh } from './service';

const MAX_EVENTS = 400;

export const feed = reactive({
	items: [] as ServiceEvent[],
	status: 'idle' as StreamStatus,
	detail: '',
	paused: false,
	loaded: false
});

function eventKey(event: ServiceEvent): string {
	return `${event.time}|${event.id}|${event.type}`;
}

/** Merge by identity+time so reconnects and log replay never duplicate rows. */
function merge(events: ServiceEvent[]): void {
	const map = new Map<string, ServiceEvent>();
	for (const item of [...feed.items, ...events]) map.set(eventKey(item), item);
	feed.items = [...map.values()]
		.sort((left, right) => left.time.localeCompare(right.time) || left.id - right.id)
		.slice(-MAX_EVENTS);
}

function sideEffects(event: ServiceEvent): void {
	const data = (event.data || {}) as Record<string, unknown>;
	switch (event.type) {
		case 'browser-state': {
			if (typeof data.profileId !== 'string' || typeof data.status !== 'string') return;
			const runtime: RuntimeState = { id: data.profileId, status: data.status as RuntimeState['status'] };
			if (typeof data.pid === 'number') runtime.pid = data.pid;
			if (typeof data.error === 'string') runtime.error = data.error;
			applyRuntime(data.profileId, runtime);
			return;
		}
		case 'browser.created':
		case 'browser.updated':
		case 'browser.deleted':
			scheduleBrowserRefresh();
			return;
		case 'userscript.created':
		case 'userscript.updated':
		case 'userscript.deleted':
			scheduleScriptRefresh();
			return;
		case 'settings.updated':
			void refreshSettings(true);
			return;
		default:
			return;
	}
}

const stream = new EventStreamClient({
	onEvent(event) {
		merge([event]);
		feed.loaded = true;
		sideEffects(event);
	},
	onStatus(status, detail) {
		feed.status = status;
		if (detail) feed.detail = detail;
		feed.paused = status === 'paused';
	},
	onUnauthorized() {
		expireSession('事件流认证失败，请重新连接。');
	},
	onReconnect() {
		void loadLogs(true);
		void loadAll({ quiet: true });
	}
});

export async function loadLogs(quiet = false): Promise<void> {
	try {
		merge(await api.logs(200));
		feed.loaded = true;
	} catch (error) {
		if (!quiet) feed.detail = error instanceof Error ? error.message : '读取事件记录失败';
	}
}

export async function startFeed(): Promise<void> {
	if (feed.status !== 'idle') return;
	feed.status = 'connecting';
	await loadLogs(true);
	stream.start();
}

export function stopFeed(): void {
	stream.stop();
	feed.items = [];
	feed.status = 'idle';
	feed.detail = '';
	feed.paused = false;
	feed.loaded = false;
}

export function pauseFeed(): void {
	stream.pause();
	feed.paused = true;
}

export function resumeFeed(): void {
	if (!feed.paused) return;
	feed.paused = false;
	stream.resume();
}

export function clearFeed(): void {
	feed.items = [];
}

export function eventProfileId(event: ServiceEvent): string {
	const data = (event.data || {}) as Record<string, unknown>;
	return typeof data.profileId === 'string' ? data.profileId : '';
}
