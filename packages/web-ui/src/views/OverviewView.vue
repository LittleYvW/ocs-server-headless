<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import EmptyState from '@/components/EmptyState.vue';
import PageHead from '@/components/PageHead.vue';
import StatusMark from '@/components/StatusMark.vue';
import { feed } from '@/stores/events';
import { isPending, refreshBrowsers, refreshSystem, runAction, service } from '@/stores/service';
import { eventLabel, eventSummary, formatBytes, formatClock, relativeTime, shortId } from '@/lib/format';

const router = useRouter();

const running = computed(() => service.browsers.filter((item) => item.runtime.status === 'running').length);
const active = computed(
	() => service.browsers.filter((item) => ['starting', 'running', 'stopping'].includes(item.runtime.status)).length
);
const capacity = computed(() => service.system?.maxBrowsers ?? 0);
const slots = computed(() => Array.from({ length: Math.min(capacity.value || 4, 64) }, (_, index) => index));
const enabledScripts = computed(() => service.scripts.filter((item) => item.enabled).length);
const atCapacity = computed(() => capacity.value > 0 && running.value >= capacity.value);
const recentEvents = computed(() => feed.items.slice(-7).reverse());
const host = computed(() => service.system?.resources);
const browserMemory = computed(() =>
	service.browsers
		.filter((browser) => browser.runtime.status === 'running')
		.reduce((sum, browser) => sum + (browser.runtime.resources?.memoryMB || 0), 0)
);
let resourceTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
	resourceTimer = setInterval(() => {
		void refreshSystem(true);
		void refreshBrowsers(true);
	}, 10000);
});
onBeforeUnmount(() => clearInterval(resourceTimer));

function quickAction(id: string, status: string): void {
	if (status === 'running') void runAction(id, 'stop');
	else if (status === 'stopped' || status === 'error') void runAction(id, 'start');
}

function openInstance(id: string): void {
	void router.push(`/instances/${id}`);
}

function createInstance(): void {
	void router.push({ path: '/instances', query: { create: '1' } });
}
</script>

<template>
	<PageHead
		kicker="Overview / 01"
		title="运行态势"
	>
		<template #actions>
			<button
				type="button"
				class="btn btn--primary"
				@click="createInstance"
			>
				<AppIcon
					name="plus"
					:size="14"
				/>
				新建实例
			</button>
		</template>
	</PageHead>

	<section class="metrics">
		<div class="metric">
			<span class="metric__label">运行中 / 容量</span>
			<span class="metric__value"
				>{{ running }}<em>/ {{ capacity || '—' }}</em></span
			>
			<div
				class="meter"
				:aria-label="`${running} / ${capacity} 运行`"
			>
				<span
					v-for="slot in slots"
					:key="slot"
					class="meter__tick"
					:class="{ 'is-on': slot < running }"
					aria-hidden="true"
				></span>
			</div>
			<span class="metric__foot">{{ atCapacity ? '已达并发上限' : '可用并发槽位' }}</span>
		</div>
		<div class="metric">
			<span class="metric__label">实例总数</span>
			<span class="metric__value">{{ service.browsers.length }}</span>
			<span class="metric__foot">{{ active }} 个活动进程</span>
		</div>
		<div class="metric">
			<span class="metric__label">用户脚本</span>
			<span class="metric__value">{{ service.scripts.length }}</span>
			<span class="metric__foot">{{ enabledScripts }} 个已启用</span>
		</div>
		<div class="metric">
			<span class="metric__label">事件缓存</span>
			<span class="metric__value">{{ feed.items.length }}</span>
			<span class="metric__foot">最多 400 条本地记录</span>
		</div>
	</section>

	<section
		v-if="host"
		class="panel host-panel"
	>
		<header class="panel__head">
			<span class="panel__title">服务端资源</span><span class="dim small">每 10 秒刷新</span>
		</header>
		<div class="host-metrics">
			<div>
				<span>可用内存 / 总内存</span
				><strong class="mono"
					>{{ formatBytes(host.freeMemoryMB * 1024 * 1024) }} /
					{{ formatBytes(host.totalMemoryMB * 1024 * 1024) }}</strong
				>
			</div>
			<div>
				<span>运行中浏览器内存</span><strong class="mono">{{ formatBytes(browserMemory * 1024 * 1024) }}</strong>
			</div>
			<div>
				<span>CPU 核心</span><strong class="mono">{{ host.cpuCount }}</strong>
			</div>
			<div>
				<span>系统负载 · 1 / 5 / 15 分钟</span
				><strong class="mono">{{ host.loadAverage.map((value) => value.toFixed(2)).join(' / ') }}</strong>
			</div>
		</div>
		<footer class="panel__foot">
			<span>实例 CPU 统计包含浏览器子进程，多核并行可超过 100%。</span
			><span
				v-if="service.system?.resourcePolicy?.minFreeMemoryMB"
				class="mono"
				>启动预留 {{ service.system.resourcePolicy.minFreeMemoryMB }} MB</span
			>
		</footer>
	</section>

	<div class="grid-split">
		<div class="stack gap-16 overview-left">
			<section class="panel">
				<header class="panel__head">
					<span class="panel__title">Instances</span>
					<RouterLink
						to="/instances"
						class="panel__link"
					>
						全部实例
						<AppIcon
							name="right"
							:size="12"
						/>
					</RouterLink>
				</header>

				<EmptyState
					v-if="!service.browsers.length"
					text="尚未创建实例。"
				>
					<button
						type="button"
						class="btn btn--sm"
						@click="createInstance"
					>
						新建实例
					</button>
				</EmptyState>

				<div
					v-else
					class="rows"
				>
					<div
						v-for="item in service.browsers.slice(0, 6)"
						:key="item.id"
						class="row instance-row row--link"
						@click="openInstance(item.id)"
					>
						<StatusMark
							:status="item.runtime.status"
							dot-only
						/>
						<div class="instance-row__main">
							<span class="instance-row__name">{{ item.name }}</span>
							<span class="instance-row__url mono truncate">{{ item.startUrl }}</span>
						</div>
						<div class="instance-row__meta">
							<span class="mono">{{ shortId(item.id) }}</span>
							<span>{{ relativeTime(item.updatedAt) }}</span>
							<span
								v-if="item.runtime.status === 'running' && item.runtime.resources"
								class="mono"
								>{{ item.runtime.resources.memoryMB.toFixed(1) }} MB · CPU
								{{ item.runtime.resources.cpuPercent.toFixed(1) }}%</span
							>
						</div>
						<button
							type="button"
							class="icon-btn"
							:disabled="isPending(item.id) || item.runtime.status === 'starting' || item.runtime.status === 'stopping'"
							:title="item.runtime.status === 'running' ? '停止' : '启动'"
							@click.stop="quickAction(item.id, item.runtime.status)"
						>
							<AppIcon
								:name="item.runtime.status === 'running' ? 'stop' : 'play'"
								:size="15"
							/>
						</button>
						<AppIcon
							name="right"
							:size="13"
							class="instance-row__chevron"
						/>
					</div>
				</div>

				<footer
					v-if="service.browsers.length > 6"
					class="panel__foot"
				>
					<span>仅显示前 6 个实例</span>
					<RouterLink
						to="/instances"
						class="panel__link"
						>查看全部 {{ service.browsers.length }} 个</RouterLink
					>
				</footer>
			</section>

			<section class="panel">
				<header class="panel__head">
					<span class="panel__title">Automation</span>
					<span class="dim small">{{ service.automation.length }} 个程序</span>
				</header>
				<div
					v-if="!service.automation.length"
					class="empty"
				>
					未加载自动化程序。
				</div>
				<div
					v-else
					class="auto-lines"
				>
					<div
						v-for="definition in service.automation.slice(0, 6)"
						:key="definition.name"
						class="auto-line"
					>
						<span class="auto-line__dot"></span>
						<span class="auto-line__name truncate">{{ definition.name }}</span>
						<span class="auto-line__meta mono">{{ Object.keys(definition.configs).length }} cfg</span>
					</div>
				</div>
				<footer class="panel__foot">
					<span>启动实例后按配置顺序执行</span>
					<span class="mono">builtin</span>
				</footer>
			</section>
		</div>

		<aside class="stack gap-16">
			<section class="panel">
				<header class="panel__head">
					<span class="panel__title">Service</span>
					<span class="tag tag--ok">Headless</span>
				</header>
				<div class="meta-list">
					<div class="meta-list__row">
						<span>服务</span><span class="mono">{{ service.system?.name || '—' }}</span>
					</div>
					<div class="meta-list__row">
						<span>API</span><span class="mono">v{{ service.system?.apiVersion ?? '—' }}</span>
					</div>
					<div class="meta-list__row">
						<span>Node</span><span class="mono">{{ service.system?.node || '—' }}</span>
					</div>
					<div class="meta-list__row">
						<span>平台</span><span class="mono">{{ service.system?.platform || '—' }}</span>
					</div>
					<div class="meta-list__row">
						<span>同步</span><span class="mono">{{ service.syncedAt ? formatClock(service.syncedAt) : '—' }}</span>
					</div>
				</div>
				<div class="cap-list">
					<span
						v-for="capability in service.system?.capabilities || []"
						:key="capability"
						class="tag tag--dim"
					>
						{{ capability }}
					</span>
				</div>
			</section>

			<section class="panel">
				<header class="panel__head">
					<span class="panel__title">Live Events</span>
					<span
						class="status"
						:class="feed.status === 'live' ? 'status--running' : 'status--stopped'"
					>
						<span class="status__dot"></span>
						{{ feed.status === 'live' ? '实时' : '未连接' }}
					</span>
				</header>
				<div
					v-if="!recentEvents.length"
					class="empty"
				>
					等待事件。
				</div>
				<div
					v-else
					class="event-mini"
				>
					<div
						v-for="event in recentEvents"
						:key="`${event.id}-${event.type}`"
						class="event-mini__row"
					>
						<span class="mono event-mini__time">{{ formatClock(event.time) }}</span>
						<span class="event-mini__type">{{ eventLabel(event.type) }}</span>
						<span class="event-mini__data truncate mono">{{ eventSummary(event) }}</span>
					</div>
				</div>
				<footer class="panel__foot">
					<span>{{ feed.items.length }} 条缓存</span>
					<RouterLink
						to="/events"
						class="panel__link"
						>事件流</RouterLink
					>
				</footer>
			</section>
		</aside>
	</div>
</template>

<style scoped>
.host-panel {
	margin-bottom: 18px;
}
.host-metrics {
	display: grid;
	grid-template-columns: 1.4fr 1fr 0.5fr 1.2fr;
	gap: 18px;
	padding: 18px;
}
.host-metrics > div {
	display: flex;
	flex-direction: column;
	gap: 8px;
	color: var(--text-3);
	font-size: 11px;
}
.host-metrics strong {
	color: var(--text-1);
	font-size: 12px;
	font-weight: 400;
}
.panel__link {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	font-size: 11px;
	color: var(--text-3);
	transition: color 0.16s;
}

.panel__link:hover {
	color: var(--accent);
}

.instance-row {
	grid-template-columns: 14px minmax(0, 1fr) auto 30px 14px;
}

.instance-row__main {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.instance-row__name {
	font-size: 13px;
	color: var(--text-1);
}

.instance-row__url {
	font-size: 10.5px;
	color: var(--text-3);
}

.instance-row__meta {
	display: flex;
	flex-direction: column;
	align-items: flex-end;
	gap: 2px;
	font-size: 10px;
	color: var(--text-3);
}

.instance-row__chevron {
	color: var(--text-3);
}

.meta-list {
	display: flex;
	flex-direction: column;
}

.meta-list__row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	padding: 8px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11px;
	color: var(--text-3);
}

.meta-list__row:first-child {
	border-top: 0;
}

.meta-list__row .mono {
	font-size: 10.5px;
	color: var(--text-2);
	text-align: right;
	overflow-wrap: anywhere;
}

.cap-list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding: 14px 18px 18px;
	border-top: 1px solid var(--line-1);
}

.auto-lines {
	display: flex;
	flex-direction: column;
}

.auto-line {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11.5px;
}

.auto-line:first-child {
	border-top: 0;
}

.auto-line__dot {
	width: 4px;
	height: 4px;
	flex: none;
	border: 1px solid var(--accent-line);
	border-radius: 50%;
}

.auto-line__name {
	color: var(--text-2);
}

.auto-line__meta {
	margin-left: auto;
	font-size: 9px;
	letter-spacing: 0.06em;
	color: var(--text-3);
}

.event-mini {
	display: flex;
	flex-direction: column;
}

.event-mini__row {
	display: grid;
	grid-template-columns: 52px auto minmax(0, 1fr);
	gap: 10px;
	align-items: baseline;
	padding: 8px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11px;
}

.event-mini__row:first-child {
	border-top: 0;
}

.event-mini__time {
	font-size: 9.5px;
	color: var(--text-3);
}

.event-mini__type {
	color: var(--text-2);
	white-space: nowrap;
}

.event-mini__data {
	color: var(--text-3);
	font-size: 10px;
	text-align: right;
}

@media (max-width: 560px) {
	.host-metrics {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.instance-row {
		grid-template-columns: 14px minmax(0, 1fr) 30px;
	}

	.instance-row__meta,
	.instance-row__chevron {
		display: none;
	}
}
</style>
