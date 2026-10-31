<script setup lang="ts">
import { service } from '@/stores/service';
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import EventList from '@/components/EventList.vue';
import { feed } from '@/stores/events';
import { formatClock, profileOf } from '@/lib/format';
import type { AutomationDefinition, BrowserView } from '@/api/types';

const props = defineProps<{ browser: BrowserView; definitions: AutomationDefinition[]; editable: boolean }>();
const emit = defineEmits<{ edit: [] }>();

interface FieldRow {
	key: string;
	label: string;
	value: string;
	title: string;
}

interface RunState {
	status: 'completed' | 'error' | 'running' | 'idle';
	time: string;
}

function definitionOf(entryName: string): AutomationDefinition | undefined {
	return props.definitions.find((item) => item.name === entryName);
}

function displayValue(type: string | undefined, value: unknown, label?: string): string {
	if (type === 'password') return '已保存';
	if (type === 'switch') return value ? '开' : '关';
	if (value === undefined || value === null || value === '') return '—';
	if (type === 'select' && label) return label;
	return String(value);
}

function fieldsOf(entryName: string, configs: Record<string, unknown>): FieldRow[] {
	const definition = definitionOf(entryName);
	if (!definition) {
		return Object.entries(configs).map(([key, value]) => ({
			key,
			label: key,
			value: displayValue(undefined, value),
			title: String(value ?? '')
		}));
	}
	return Object.entries(definition.configs)
		.filter(
			([, config]) =>
				!config.hide && (!config.visibleWhen || configs[config.visibleWhen.key] === config.visibleWhen.value)
		)
		.map(([key, config]) => {
			const option = config.options?.find((item) => item.value === configs[key]);
			const shown = displayValue(config.type, configs[key], option?.label);
			return {
				key,
				label: config.label,
				value: shown,
				title: config.type === 'password' ? '已保存，不显示明文' : shown
			};
		});
}

function latestRun(entryName: string): RunState {
	for (let index = feed.items.length - 1; index >= 0; index -= 1) {
		const event = feed.items[index];
		if (profileOf(event) !== props.browser.id) continue;
		if (event.type !== 'automation-result' && event.type !== 'automation-started') continue;
		const data = (event.data || {}) as Record<string, unknown>;
		if (data.name !== entryName) continue;
		if (event.type === 'automation-started') return { status: 'running', time: event.time };
		if (data.status === 'completed' || data.status === 'error') {
			return { status: data.status, time: event.time };
		}
	}
	return { status: 'idle', time: '' };
}

const configured = computed(() => props.browser.automationScripts);
const recentRuns = computed(() =>
	feed.items
		.filter(
			(event) =>
				profileOf(event) === props.browser.id &&
				['automation-started', 'automation-warning', 'automation-result', 'browser-error'].includes(event.type)
		)
		.slice(-8)
		.reverse()
);
</script>

<template>
	<section class="panel">
		<header class="panel__head">
			<span class="panel__title">Automation</span>
			<div class="auto-panel__tools">
				<span class="dim small">{{ configured.length }} 个程序</span>
				<button
					type="button"
					class="icon-btn"
					:title="editable ? '编辑自动化配置' : '先停止实例再编辑'"
					:disabled="!editable"
					@click="emit('edit')"
				>
					<AppIcon
						name="edit"
						:size="14"
					/>
				</button>
			</div>
		</header>

		<div
			v-if="!configured.length"
			class="empty"
		>
			未配置自动化程序，启动后仅打开起始地址。
		</div>

		<div
			v-else
			class="auto-runs"
		>
			<article
				v-for="(entry, index) in configured"
				:key="entry.name"
				class="auto-run"
			>
				<header class="auto-run__head">
					<span class="auto-run__index mono">{{ String(index + 1).padStart(2, '0') }}</span>
					<h3 class="auto-run__name">{{ entry.name }}</h3>
					<span
						class="tag"
						:class="{
							'tag--ok': latestRun(entry.name).status === 'completed',
							'tag--bad': latestRun(entry.name).status === 'error',
							'tag--warn': latestRun(entry.name).status === 'running',
							'tag--dim': latestRun(entry.name).status === 'idle'
						}"
					>
						{{
							latestRun(entry.name).status === 'completed'
								? '已完成'
								: latestRun(entry.name).status === 'error'
								? '失败'
								: latestRun(entry.name).status === 'running'
								? '执行中'
								: '未运行'
						}}
					</span>
					<span
						v-if="latestRun(entry.name).time"
						class="auto-run__time mono"
					>
						{{ formatClock(latestRun(entry.name).time) }}
					</span>
				</header>
				<p
					v-if="definitionOf(entry.name)?.needOCR"
					class="dim small"
					role="note"
				>
					此程序可能需要验证码识别。{{
						service.system?.ocrAvailable ? '服务已配置 OCR。' : '尚未配置 OCR，遇到验证码时登录可能失败。'
					}}
				</p>
				<div
					v-if="fieldsOf(entry.name, entry.configs).length"
					class="auto-run__fields"
				>
					<div
						v-for="field in fieldsOf(entry.name, entry.configs)"
						:key="field.key"
						class="auto-kv"
					>
						<span class="auto-kv__label">{{ field.label }}</span>
						<span
							class="auto-kv__value mono truncate"
							:title="field.title"
							>{{ field.value }}</span
						>
					</div>
				</div>
				<p
					v-else
					class="auto-run__empty"
				>
					无配置项
				</p>
			</article>
		</div>

		<footer class="panel__foot">
			<span>启动后按顺序执行；running 状态不代表自动化已完成。</span>
			<span class="mono">{{ browser.runtime.status }}</span>
		</footer>
	</section>

	<section
		v-if="recentRuns.length"
		class="panel automation-log"
	>
		<header class="panel__head">
			<span class="panel__title">Recent Runs</span>
			<span class="dim small">{{ recentRuns.length }} 条</span>
		</header>
		<EventList
			:events="recentRuns"
			empty="暂无自动化记录。"
		/>
	</section>
</template>

<style scoped>
.automation-log {
	margin-top: 18px;
}

.auto-panel__tools {
	display: flex;
	align-items: center;
	gap: 8px;
}

.auto-runs {
	display: flex;
	flex-direction: column;
}

.auto-run {
	padding: 15px 18px;
	border-top: 1px solid var(--line-1);
}

.auto-run:first-child {
	border-top: 0;
}

.auto-run__head {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.auto-run__index {
	font-size: 9px;
	letter-spacing: 0.08em;
	color: var(--accent);
}

.auto-run__name {
	font-size: 12.5px;
	font-weight: 400;
	color: var(--text-1);
}

.auto-run__time {
	margin-left: auto;
	font-size: 9.5px;
	color: var(--text-3);
}

.auto-run__fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
	gap: 2px 22px;
	margin-top: 11px;
}

.auto-kv {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 14px;
	padding: 5px 0;
	border-bottom: 1px solid rgba(255, 255, 255, 0.035);
	min-width: 0;
}

.auto-kv__label {
	font-size: 10.5px;
	color: var(--text-3);
	white-space: nowrap;
}

.auto-kv__value {
	font-size: 10.5px;
	color: var(--text-2);
	text-align: right;
	max-width: 62%;
}

.auto-run__empty {
	margin-top: 8px;
	font-size: 11px;
	color: var(--text-3);
}
</style>
