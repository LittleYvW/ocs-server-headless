<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import InstanceForm from '@/components/InstanceForm.vue';
import PageHead from '@/components/PageHead.vue';
import StatusMark from '@/components/StatusMark.vue';
import type { BrowserView } from '@/api/types';
import { isPending, removeBrowser, runAction, service } from '@/stores/service';
import { relativeTime, runtimeMessage, shortId } from '@/lib/format';

const route = useRoute();
const router = useRouter();

const formOpen = ref(false);
const editing = ref<BrowserView | null>(null);
const deleting = ref<BrowserView | null>(null);
const removing = ref(false);

const running = computed(() => service.browsers.filter((item) => item.runtime.status === 'running').length);
const capacity = computed(() => service.system?.maxBrowsers ?? 0);
const atCapacity = computed(() => capacity.value > 0 && running.value >= capacity.value);

function openCreate(): void {
	editing.value = null;
	formOpen.value = true;
}

function openEdit(browser: BrowserView): void {
	editing.value = browser;
	formOpen.value = true;
}

function canConfigure(browser: BrowserView): boolean {
	return !browser.runtime.pid && ['stopped', 'error'].includes(browser.runtime.status);
}

function onSaved(browser: BrowserView): void {
	if (!editing.value) void router.push(`/instances/${browser.id}`);
}

function askDelete(browser: BrowserView): void {
	deleting.value = browser;
}

async function confirmDelete(): Promise<void> {
	if (!deleting.value || removing.value) return;
	removing.value = true;
	const ok = await removeBrowser(deleting.value.id);
	removing.value = false;
	if (ok) deleting.value = null;
}

function checkCreateQuery(): void {
	if (route.query.create !== '1') return;
	openCreate();
	void router.replace({ path: '/instances' });
}

onMounted(checkCreateQuery);
watch(() => route.query.create, checkCreateQuery);
</script>

<template>
	<PageHead
		kicker="Instances / 02"
		title="实例"
		note="浏览器进程由服务端持有，关闭页面不影响运行；配置与运行状态在刷新后保留。"
	>
		<template #actions>
			<span
				class="tag"
				:class="atCapacity ? 'tag--warn' : 'tag--dim'"
				>{{ running }} / {{ capacity || '—' }} 运行</span
			>
			<BaseButton
				variant="primary"
				@click="openCreate"
			>
				<AppIcon
					name="plus"
					:size="14"
				/>
				新建实例
			</BaseButton>
		</template>
	</PageHead>

	<section class="panel">
		<header class="panel__head">
			<span class="panel__title">Profiles</span>
			<span class="dim small">{{ service.browsers.length }} 个配置</span>
		</header>

		<EmptyState
			v-if="!service.browsers.length"
			text="尚未创建实例。"
		>
			<button
				type="button"
				class="btn btn--sm"
				@click="openCreate"
			>
				新建实例
			</button>
		</EmptyState>

		<template v-else>
			<div class="table-head instance-head">
				<span></span>
				<span>实例</span>
				<span>起始地址</span>
				<span>自动化</span>
				<span>更新</span>
				<span class="instance-head__actions">操作</span>
			</div>
			<div class="rows">
				<div
					v-for="item in service.browsers"
					:key="item.id"
					class="row instance-row row--link"
					@click="router.push(`/instances/${item.id}`)"
				>
					<StatusMark
						:status="item.runtime.status"
						dot-only
					/>
					<div class="instance-cell">
						<span class="instance-cell__name">{{ item.name }}</span>
						<span class="instance-cell__meta mono">{{ shortId(item.id) }}</span>
						<span
							v-if="item.group || item.tags?.length"
							class="instance-cell__meta truncate"
							>{{ [item.group, ...(item.tags || [])].filter(Boolean).join(' · ') }}</span
						>
						<span
							v-if="item.runtime.error"
							class="instance-cell__error"
							>{{ runtimeMessage(item.runtime.error) }}</span
						>
					</div>
					<span class="instance-url mono truncate">{{ item.startUrl }}</span>
					<span class="instance-count mono">{{ item.automationScripts.length }} prog</span>
					<span class="instance-time">{{ relativeTime(item.updatedAt) }}</span>
					<div
						class="instance-actions"
						@click.stop
					>
						<button
							type="button"
							class="icon-btn"
							:disabled="isPending(item.id) || !['running', 'stopped', 'error'].includes(item.runtime.status)"
							:title="item.runtime.status === 'running' ? '停止实例' : '启动实例'"
							@click="runAction(item.id, item.runtime.status === 'running' ? 'stop' : 'start')"
						>
							<AppIcon
								:name="item.runtime.status === 'running' ? 'stop' : 'play'"
								:size="15"
							/>
						</button>
						<button
							type="button"
							class="icon-btn"
							:disabled="!canConfigure(item) || isPending(item.id)"
							:title="canConfigure(item) ? '编辑配置' : '先停止实例'"
							@click="openEdit(item)"
						>
							<AppIcon
								name="edit"
								:size="14"
							/>
						</button>
						<button
							type="button"
							class="icon-btn icon-btn--danger"
							:disabled="!canConfigure(item) || isPending(item.id)"
							:title="canConfigure(item) ? '删除配置' : '先停止实例'"
							@click="askDelete(item)"
						>
							<AppIcon
								name="trash"
								:size="14"
							/>
						</button>
						<button
							type="button"
							class="icon-btn"
							title="打开详情"
							@click="router.push(`/instances/${item.id}`)"
						>
							<AppIcon
								name="right"
								:size="14"
							/>
						</button>
					</div>
				</div>
			</div>
		</template>
	</section>

	<InstanceForm
		:open="formOpen"
		:profile="editing"
		:definitions="service.automation"
		:scripts="service.scripts"
		@close="formOpen = false"
		@saved="onSaved"
	/>

	<ConfirmDialog
		:open="!!deleting"
		title="删除实例配置"
		:message="`确定删除「${deleting?.name || ''}」的管理配置吗？`"
		note="磁盘上的浏览器 profile、Cookie 与下载文件会保留；如需回收磁盘，请停止服务后由管理员清理。"
		confirm-text="删除配置"
		:danger="true"
		:busy="removing"
		@cancel="deleting = null"
		@confirm="confirmDelete"
	/>
</template>

<style scoped>
.instance-head,
.instance-row {
	grid-template-columns: 14px minmax(0, 1.25fr) minmax(0, 1.1fr) 62px 82px 136px;
}

.instance-head__actions {
	text-align: right;
}

.instance-cell {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.instance-cell__name {
	font-size: 13px;
	color: var(--text-1);
}

.instance-cell__meta {
	font-size: 9.5px;
	letter-spacing: 0.06em;
	color: var(--text-3);
}

.instance-cell__error {
	font-size: 10.5px;
	color: var(--danger);
	line-height: 1.4;
}

.instance-url {
	font-size: 10.5px;
	color: var(--text-3);
}

.instance-count {
	font-size: 10px;
	color: var(--text-2);
}

.instance-time {
	font-size: 10.5px;
	color: var(--text-3);
}

.instance-actions {
	display: flex;
	justify-content: flex-end;
	gap: 2px;
}

@media (max-width: 1120px) {
	.instance-head,
	.instance-row {
		grid-template-columns: 14px minmax(0, 1.4fr) minmax(0, 1.1fr) 74px 136px;
	}

	.instance-head span:nth-child(4),
	.instance-row .instance-count {
		display: none;
	}
}

@media (max-width: 820px) {
	.instance-head,
	.instance-row {
		grid-template-columns: 14px minmax(0, 1fr) 136px;
	}

	.instance-head span:nth-child(3),
	.instance-head span:nth-child(5),
	.instance-url,
	.instance-time {
		display: none;
	}
}
</style>
