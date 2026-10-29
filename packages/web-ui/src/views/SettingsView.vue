<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import PageHead from '@/components/PageHead.vue';
import { apiBase } from '@/api/client';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import { forgetRemembered, logout, session } from '@/stores/session';
import { service } from '@/stores/service';
import { toast } from '@/stores/toasts';

const draft = ref('{}');
const baseline = ref('{}');
const parseError = ref('');
const saving = ref(false);
const savedAt = ref('');

const dirty = computed(() => draft.value !== baseline.value);

watch(
	() => service.settings,
	(settings) => {
		if (!settings) return;
		const text = JSON.stringify(settings.ocs ?? {}, null, 2);
		if (!dirty.value) {
			draft.value = text;
			baseline.value = text;
		}
	},
	{ immediate: true }
);

watch(draft, () => {
	parseError.value = '';
});

function formatDraft(): void {
	try {
		const parsed = JSON.parse(draft.value);
		draft.value = JSON.stringify(parsed, null, 2);
		parseError.value = '';
	} catch (error) {
		parseError.value = `JSON 解析失败：${(error as Error).message}`;
	}
}

function restore(): void {
	draft.value = baseline.value;
	parseError.value = '';
}

async function save(): Promise<void> {
	if (saving.value) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(draft.value);
	} catch (error) {
		parseError.value = `JSON 解析失败：${(error as Error).message}`;
		return;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		parseError.value = 'settings.ocs 必须是一个 JSON 对象。';
		return;
	}
	saving.value = true;
	try {
		const updated = await api.settings.update(parsed as Record<string, unknown>);
		service.settings = updated;
		const text = JSON.stringify(updated.ocs ?? {}, null, 2);
		draft.value = text;
		baseline.value = text;
		savedAt.value = new Date().toISOString();
		toast('平台设置已保存', 'ok');
	} catch (error) {
		parseError.value = describeError(error);
	} finally {
		saving.value = false;
	}
}

function exit(): void {
	logout();
}
</script>

<template>
	<PageHead
		kicker="Settings / 04"
		title="平台设置"
		note="运行时环境、令牌、密钥、浏览器路径与实例容量由部署变量控制，不在界面中暴露。"
	/>

	<div class="settings-grid">
		<section class="panel">
			<header class="panel__head">
				<span class="panel__title">Deployment</span>
				<span class="tag tag--dim mono">{{ service.system?.platform || '—' }}</span>
			</header>
			<div class="meta-list">
				<div class="meta-list__row">
					<span>API 根路径</span><span class="mono">{{ apiBase() }}</span>
				</div>
				<div class="meta-list__row">
					<span>服务</span><span class="mono">{{ service.system?.name || '—' }}</span>
				</div>
				<div class="meta-list__row">
					<span>API 版本</span><span class="mono">v{{ service.system?.apiVersion ?? '—' }}</span>
				</div>
				<div class="meta-list__row">
					<span>Node</span><span class="mono">{{ service.system?.node || '—' }}</span>
				</div>
				<div class="meta-list__row">
					<span>无头模式</span><span class="mono">{{ service.system?.headless ? 'enabled' : 'disabled' }}</span>
				</div>
				<div class="meta-list__row">
					<span>并发容量</span><span class="mono">{{ service.system?.maxBrowsers ?? '—' }}</span>
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
				<span class="panel__title">Session</span>
				<span
					class="tag"
					:class="session.remembered ? 'tag--warn' : 'tag--dim'"
				>
					{{ session.remembered ? 'localStorage' : 'sessionStorage' }}
				</span>
			</header>
			<div class="session-body">
				<p class="session-text">
					管理令牌{{
						session.remembered
							? '保存在此浏览器 localStorage，关闭标签页后仍保留。'
							: '仅保存在当前标签页会话，关闭后自动失效。'
					}}
				</p>
				<div class="session-actions">
					<BaseButton
						size="sm"
						variant="ghost"
						:disabled="!session.remembered"
						@click="forgetRemembered"
					>
						清除记住的令牌
					</BaseButton>
					<BaseButton
						size="sm"
						variant="danger"
						@click="exit"
					>
						<AppIcon
							name="power"
							:size="12"
						/>
						断开连接
					</BaseButton>
				</div>
				<p class="session-hint">令牌不会写入 URL、事件或客户端日志。</p>
			</div>
		</section>
	</div>

	<section class="panel settings-panel">
		<header class="panel__head">
			<div class="json-head">
				<span class="panel__title">settings.ocs</span>
				<span
					class="tag"
					:class="dirty ? 'tag--warn' : 'tag--dim'"
					>{{ dirty ? '未保存' : '已同步' }}</span
				>
			</div>
			<div class="json-tools">
				<span
					v-if="savedAt"
					class="dim small mono"
					>saved {{ savedAt.slice(11, 19) }}</span
				>
				<BaseButton
					size="sm"
					variant="ghost"
					@click="formatDraft"
					>格式化</BaseButton
				>
				<BaseButton
					size="sm"
					variant="ghost"
					:disabled="!dirty"
					@click="restore"
					>还原</BaseButton
				>
				<BaseButton
					size="sm"
					variant="primary"
					:busy="saving"
					:disabled="!dirty"
					@click="save"
					>保存</BaseButton
				>
			</div>
		</header>
		<div class="json-body">
			<p class="json-note">
				<AppIcon
					name="warning"
					:size="13"
				/>
				<span>PATCH 会整体替换 settings.ocs，保存内容即完整对象。</span>
			</p>
			<textarea
				v-model="draft"
				class="json-editor"
				spellcheck="false"
				aria-label="settings.ocs JSON"
			></textarea>
			<p
				v-if="parseError"
				class="inline-error"
			>
				{{ parseError }}
			</p>
		</div>
		<footer class="panel__foot">
			<span>业务配置容器，不包含监听地址、密钥或浏览器可执行文件路径。</span>
			<RouterLink
				to="/events"
				class="foot-link"
				>查看设置事件</RouterLink
			>
		</footer>
	</section>
</template>

<style scoped>
.settings-grid {
	display: grid;
	grid-template-columns: minmax(0, 1.3fr) minmax(0, 0.7fr);
	gap: 18px;
	margin-bottom: 18px;
}

.meta-list {
	display: flex;
	flex-direction: column;
}

.meta-list__row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 18px;
	padding: 9px 18px;
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

.session-body {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 18px;
}

.session-text {
	font-size: 12px;
	line-height: 1.7;
	color: var(--text-2);
}

.session-actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.session-hint {
	font-size: 10.5px;
	color: var(--text-3);
}

.json-head {
	display: flex;
	align-items: center;
	gap: 10px;
}

.json-tools {
	display: flex;
	align-items: center;
	gap: 8px;
	flex-wrap: wrap;
	justify-content: flex-end;
}

.json-body {
	display: flex;
	flex-direction: column;
	gap: 12px;
	padding: 18px;
}

.json-note {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 11px;
	color: var(--text-3);
}

.json-editor {
	width: 100%;
	min-height: 300px;
	padding: 14px;
	border: 1px solid var(--line-2);
	border-radius: var(--radius);
	background: rgba(0, 0, 0, 0.24);
	color: var(--text-2);
	font-family: var(--font-mono);
	font-size: 12px;
	line-height: 1.7;
	resize: vertical;
	outline: none;
	transition: border-color 0.18s;
}

.json-editor:focus {
	border-color: var(--accent-line);
}

.foot-link {
	font-size: 11px;
	color: var(--text-3);
}

.foot-link:hover {
	color: var(--accent);
}

@media (max-width: 980px) {
	.settings-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
