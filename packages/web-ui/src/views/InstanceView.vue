<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import EventList from '@/components/EventList.vue';
import InstanceForm from '@/components/InstanceForm.vue';
import AutomationPanel from '@/components/AutomationPanel.vue';
import DownloadsPanel from '@/components/DownloadsPanel.vue';
import PagesPanel from '@/components/PagesPanel.vue';
import StatusMark from '@/components/StatusMark.vue';
import { feed } from '@/stores/events';
import { browserById, isPending, removeBrowser, runAction, service } from '@/stores/service';
import { profileOf, runtimeMessage, shortId } from '@/lib/format';

type Tab = 'pages' | 'automation' | 'downloads' | 'events';

const route = useRoute();
const router = useRouter();

const id = computed(() => String(route.params.id || ''));
const browser = computed(() => browserById(id.value));
const status = computed(() => browser.value?.runtime.status || 'stopped');
const busy = computed(() => isPending(id.value));
const configurable = computed(() => ['stopped', 'error'].includes(status.value));
const canStop = computed(() => ['running', 'starting'].includes(status.value));
const tab = ref<Tab>('pages');
const pagesCount = ref(0);
const downloadsCount = ref(0);
const formOpen = ref(false);
const confirmOpen = ref(false);
const removing = ref(false);
const settled = ref(false);

const instanceEvents = computed(() => feed.items.filter((event) => profileOf(event) === id.value).reverse());
const tabs = computed(() => [
	{ key: 'pages' as Tab, label: '页面', count: pagesCount.value },
	{ key: 'automation' as Tab, label: '自动化', count: browser.value?.automationScripts.length || 0 },
	{ key: 'downloads' as Tab, label: '下载', count: downloadsCount.value },
	{ key: 'events' as Tab, label: '事件', count: instanceEvents.value.length }
]);

function togglePower(): void {
	if (!browser.value || busy.value) return;
	void runAction(id.value, canStop.value ? 'stop' : 'start');
}

function restart(): void {
	if (!browser.value || busy.value) return;
	void runAction(id.value, 'restart');
}

async function confirmRemove(): Promise<void> {
	if (!browser.value) return;
	removing.value = true;
	const removed = await removeBrowser(id.value);
	removing.value = false;
	if (removed) {
		confirmOpen.value = false;
		await router.replace('/instances');
	}
}

watch(id, () => {
	tab.value = 'pages';
	pagesCount.value = 0;
	downloadsCount.value = 0;
	formOpen.value = false;
	confirmOpen.value = false;
});

// Page IDs are scoped to one browser run; do not keep a stale tab count.
watch(status, (value) => {
	if (value !== 'running') pagesCount.value = 0;
});

let settleTimer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
	settleTimer = setTimeout(() => {
		settled.value = true;
	}, 650);
});

onBeforeUnmount(() => clearTimeout(settleTimer));
</script>

<template>
	<template v-if="browser">
		<header class="page-head">
			<div class="page-head__main">
				<div class="instance-top">
					<RouterLink
						to="/instances"
						class="back-link"
					>
						<AppIcon
							name="left"
							:size="12"
						/>
						实例
					</RouterLink>
					<StatusMark :status="status" />
					<span class="tag tag--dim mono">{{ shortId(browser.id) }}</span>
					<span
						v-if="browser.runtime.pid"
						class="tag tag--dim mono"
						>pid {{ browser.runtime.pid }}</span
					>
				</div>
				<h1 class="display">{{ browser.name }}</h1>
				<p class="note instance-url mono truncate">{{ browser.startUrl }}</p>
			</div>
			<div class="page-head__actions">
				<BaseButton
					:variant="canStop ? 'line' : 'primary'"
					:busy="busy"
					:disabled="status === 'stopping'"
					@click="togglePower"
				>
					<AppIcon
						:name="canStop ? 'stop' : 'play'"
						:size="13"
					/>
					{{ canStop ? '停止' : '启动' }}
				</BaseButton>
				<BaseButton
					:disabled="busy || status === 'starting' || status === 'stopping'"
					@click="restart"
				>
					<AppIcon
						name="restart"
						:size="13"
					/>
					重启
				</BaseButton>
				<BaseButton
					:disabled="!configurable || busy"
					title="需先停止实例"
					@click="formOpen = true"
				>
					<AppIcon
						name="edit"
						:size="13"
					/>
					编辑
				</BaseButton>
				<button
					type="button"
					class="icon-btn icon-btn--danger"
					:disabled="!configurable || busy"
					title="删除配置"
					@click="confirmOpen = true"
				>
					<AppIcon
						name="trash"
						:size="15"
					/>
				</button>
			</div>
		</header>
		<div class="rule"></div>

		<div
			v-if="browser.runtime.error"
			class="inline-error instance-error"
		>
			{{ runtimeMessage(browser.runtime.error) }}
		</div>

		<div
			class="tabs"
			role="tablist"
		>
			<button
				v-for="item in tabs"
				:key="item.key"
				type="button"
				class="tab"
				:class="{ 'is-active': tab === item.key }"
				role="tab"
				:aria-selected="tab === item.key"
				@click="tab = item.key"
			>
				{{ item.label }}
				<span
					v-if="item.count"
					class="tab__count"
					>{{ item.count }}</span
				>
			</button>
		</div>

		<PagesPanel
			v-if="tab === 'pages'"
			:key="`pages-${browser.id}`"
			:browser="browser"
			@count="pagesCount = $event"
			@start="togglePower"
		/>

		<AutomationPanel
			v-else-if="tab === 'automation'"
			:key="`automation-${browser.id}`"
			:browser="browser"
			:definitions="service.automation"
			:editable="configurable"
			@edit="formOpen = true"
		/>

		<DownloadsPanel
			v-else-if="tab === 'downloads'"
			:key="`downloads-${browser.id}`"
			:browser="browser"
			@count="downloadsCount = $event"
		/>

		<section
			v-else
			class="panel"
		>
			<header class="panel__head">
				<span class="panel__title">Instance Events</span>
				<div class="events-tools">
					<span class="dim small">{{ instanceEvents.length }} 条</span>
					<RouterLink
						to="/events"
						class="events-link"
						>全部事件</RouterLink
					>
				</div>
			</header>
			<EventList
				:events="instanceEvents.slice(0, 80)"
				empty="该实例暂无事件。"
			/>
			<footer class="panel__foot">
				<span>仅显示最近 80 条本地缓存事件。</span>
				<span class="mono">{{ feed.status }}</span>
			</footer>
		</section>

		<InstanceForm
			:open="formOpen"
			:profile="browser"
			:definitions="service.automation"
			:scripts="service.scripts"
			@close="formOpen = false"
		/>

		<ConfirmDialog
			:open="confirmOpen"
			title="删除实例配置"
			:message="`确定删除「${browser.name}」的管理配置吗？`"
			note="磁盘上的浏览器 profile、Cookie 与下载文件会保留，不会被自动删除。"
			confirm-text="删除配置"
			:danger="true"
			:busy="removing"
			@cancel="confirmOpen = false"
			@confirm="confirmRemove"
		/>
	</template>

	<template v-else-if="!settled || service.loading">
		<div class="loading-line"><span></span></div>
		<p class="loading-label mono">LOADING INSTANCE</p>
	</template>

	<template v-else>
		<header class="page-head">
			<div class="page-head__main">
				<p class="kicker">Instance</p>
				<h1 class="display">实例</h1>
			</div>
		</header>
		<div class="rule"></div>
		<EmptyState text="实例不存在或已被删除。">
			<RouterLink
				to="/instances"
				class="btn btn--sm"
				>返回实例列表</RouterLink
			>
		</EmptyState>
	</template>
</template>

<style scoped>
.instance-top {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
	margin-bottom: 12px;
}

.back-link {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	margin-right: 4px;
	font-size: 11px;
	color: var(--text-3);
	transition: color 0.16s;
}

.back-link:hover {
	color: var(--text-1);
}

.instance-url {
	font-size: 11px;
}

.instance-error {
	margin-bottom: 18px;
}

.events-tools {
	display: flex;
	align-items: center;
	gap: 12px;
}

.events-link {
	font-size: 11px;
	color: var(--text-3);
}

.events-link:hover {
	color: var(--accent);
}

.loading-line {
	position: relative;
	width: 220px;
	height: 1px;
	margin-top: 10vh;
	background: var(--line-1);
	overflow: hidden;
}

.loading-line span {
	position: absolute;
	top: 0;
	left: 0;
	width: 34%;
	height: 1px;
	background: var(--accent);
	animation: loading-slide 1.3s var(--ease) infinite;
}

.loading-label {
	margin-top: 14px;
	font-size: 9px;
	letter-spacing: 0.3em;
	color: var(--text-3);
}

@keyframes loading-slide {
	0% {
		transform: translateX(-100%);
	}
	100% {
		transform: translateX(330%);
	}
}

@media (max-width: 680px) {
	.page-head__actions {
		justify-content: flex-start;
	}
}
</style>
