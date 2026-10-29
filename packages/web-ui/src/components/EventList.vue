<script setup lang="ts">
import { ref } from 'vue';
import AppIcon from './AppIcon.vue';
import type { ServiceEvent } from '@/api/types';
import { browserName } from '@/stores/service';
import { eventLabel, eventSummary, formatStamp, profileOf } from '@/lib/format';

withDefaults(defineProps<{ events: ServiceEvent[]; empty?: string; showInstance?: boolean }>(), {
	empty: '暂无事件。',
	showInstance: false
});

const expanded = ref(new Set<string>());

function keyOf(event: ServiceEvent): string {
	return `${event.time}|${event.id}|${event.type}`;
}

function toggle(event: ServiceEvent): void {
	const key = keyOf(event);
	if (expanded.value.has(key)) expanded.value.delete(key);
	else expanded.value.add(key);
}

function pretty(data: unknown): string {
	try {
		return JSON.stringify(data ?? {}, null, 2);
	} catch {
		return String(data);
	}
}
</script>

<template>
	<div
		v-if="!events.length"
		class="empty"
	>
		{{ empty }}
	</div>
	<div
		v-else
		class="event-list"
	>
		<div
			class="event-head"
			:class="{ 'event-head--instance': showInstance }"
		>
			<span>时间</span>
			<span>类型</span>
			<span v-if="showInstance">实例</span>
			<span>摘要</span>
			<span></span>
		</div>
		<div
			v-for="event in events"
			:key="keyOf(event)"
			class="event-row"
			:class="{ 'event-row--instance': showInstance }"
			role="button"
			tabindex="0"
			@click="toggle(event)"
			@keydown.enter.prevent="toggle(event)"
			@keydown.space.prevent="toggle(event)"
		>
			<span
				class="event-row__time mono"
				:title="event.time"
				>{{ formatStamp(event.time) }}</span
			>
			<span class="event-row__type">{{ eventLabel(event.type) }}</span>
			<span
				v-if="showInstance"
				class="event-row__instance mono truncate"
			>
				{{ profileOf(event) ? browserName(profileOf(event)) : '—' }}
			</span>
			<span class="event-row__summary truncate">{{ eventSummary(event) }}</span>
			<AppIcon
				name="right"
				:size="12"
				class="event-row__chevron"
				:class="{ 'is-open': expanded.has(keyOf(event)) }"
			/>
			<pre
				v-if="expanded.has(keyOf(event))"
				class="code event-row__raw"
				>{{ pretty(event.data) }}</pre
			>
		</div>
	</div>
</template>

<style scoped>
.event-list {
	display: flex;
	flex-direction: column;
}

.event-head,
.event-row {
	display: grid;
	grid-template-columns: 88px 100px minmax(0, 1fr) 16px;
	gap: 14px;
	align-items: baseline;
	padding: 9px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11.5px;
}

.event-head--instance,
.event-row--instance {
	grid-template-columns: 88px 100px 104px minmax(0, 1fr) 16px;
}

.event-head {
	padding-top: 0;
	padding-bottom: 9px;
	border-top: 0;
	font-family: var(--font-mono);
	font-size: 9px;
	letter-spacing: 0.18em;
	text-transform: uppercase;
	color: var(--text-3);
}

.event-row {
	cursor: pointer;
	transition: background 0.14s;
}

.event-row:hover {
	background: rgba(255, 255, 255, 0.018);
}

.event-row__time {
	font-size: 9.5px;
	color: var(--text-3);
	white-space: nowrap;
}

.event-row__type {
	color: var(--text-2);
	white-space: nowrap;
}

.event-row__instance {
	font-size: 10px;
	color: var(--text-3);
}

.event-row__summary {
	color: var(--text-3);
	font-size: 10.5px;
}

.event-row__chevron {
	align-self: center;
	color: var(--text-3);
	transition: transform 0.18s var(--ease);
}

.event-row__chevron.is-open {
	transform: rotate(90deg);
}

@media (max-width: 760px) {
	.event-head,
	.event-row {
		grid-template-columns: 70px 84px minmax(0, 1fr) 14px;
		gap: 8px;
		padding: 8px 12px;
	}

	.event-head--instance,
	.event-row--instance {
		grid-template-columns: 68px 74px 66px minmax(0, 1fr) 14px;
	}
}

@media (max-width: 560px) {
	.event-head,
	.event-row {
		grid-template-columns: 66px 70px minmax(0, 1fr) 14px;
		gap: 6px;
		padding: 8px 10px;
	}

	.event-head--instance,
	.event-row--instance {
		grid-template-columns: 66px 70px minmax(0, 1fr) 14px;
	}

	.event-head--instance span:nth-child(3),
	.event-row--instance .event-row__instance {
		display: none;
	}
}

.event-row__raw {
	grid-column: 1 / -1;
	margin-top: 4px;
	border-color: var(--line-1);
	background: rgba(0, 0, 0, 0.24);
	max-height: 240px;
	overflow: auto;
}
</style>
