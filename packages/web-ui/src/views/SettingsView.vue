<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PageHead from '@/components/PageHead.vue';
import { apiBase, saveBlob } from '@/api/client';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import { forgetRemembered, logout, session } from '@/stores/session';
import { loadAll, service } from '@/stores/service';
import { toast } from '@/stores/toasts';
import { formatBytes } from '@/lib/format';
import type { DataImportSummary } from '@/api/types';

const draft = ref('{}');
const baseline = ref('{}');
const parseError = ref('');
const saving = ref(false);
const savedAt = ref('');
const exportPassword = ref('');
const importPassword = ref('');
const exporting = ref(false);
const importing = ref(false);
const transferError = ref('');
const importFile = ref<{ name: string; size: number; content: string; format: string; encrypted: boolean }>();
const importResult = ref<DataImportSummary>();
const importConfirm = ref(false);
const importFileInput = ref<HTMLInputElement>();
let fileSelection = 0;
const allStopped = computed(() =>
	service.browsers.every((browser) => !browser.runtime.pid && ['stopped', 'error'].includes(browser.runtime.status))
);

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

async function exportData(): Promise<void> {
	if (exporting.value || !exportPassword.value.trim()) return;
	exporting.value = true;
	transferError.value = '';
	try {
		const blob = await api.data.export(exportPassword.value);
		saveBlob(blob, `ocs-server-${new Date().toISOString().slice(0, 10)}.ocsdata`);
		toast('加密配置已开始下载，请保管好导出密码', 'ok');
	} catch (error) {
		transferError.value = describeError(error);
	} finally {
		exportPassword.value = '';
		exporting.value = false;
	}
}

async function selectImport(event: Event): Promise<void> {
	const selection = ++fileSelection;
	const file = (event.target as HTMLInputElement).files?.[0];
	importFile.value = undefined;
	importResult.value = undefined;
	importPassword.value = '';
	transferError.value = '';
	if (!file) return;
	if (file.size > 20 * 1024 * 1024) {
		transferError.value = '导入文件不得超过 20 MiB。';
		return;
	}
	try {
		const content = await file.text();
		if (selection !== fileSelection) return;
		const parsed = JSON.parse(content);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请选择有效的 OCS 配置文件。');
		let format: string;
		let encrypted = false;
		if (parsed.format === 'ocs-server-headless' && typeof parsed.data === 'string') {
			format = 'OCS Server · 密码加密';
			encrypted = true;
		} else if (parsed.render !== undefined) {
			format = 'OCS Desktop';
			encrypted = typeof parsed.render === 'string';
			if (encrypted && !parsed.render.startsWith('v1:scrypt:'))
				throw new Error('此文件由桌面机器密钥加密，请在原电脑重新导出为明文或设置导出密码。');
			format += encrypted ? ' · 密码加密' : ' · 明文';
		} else if (parsed.version === 1 && Array.isArray(parsed.browsers) && Array.isArray(parsed.userScripts)) {
			format = `OCS Server · 明文 · ${parsed.browsers.length} 个实例 / ${parsed.userScripts.length} 个脚本`;
		} else throw new Error('未识别的 OCS 配置文件。');
		importFile.value = { name: file.name, size: file.size, content, format, encrypted };
	} catch (error) {
		transferError.value = error instanceof SyntaxError ? '文件不是有效 JSON。' : (error as Error).message;
	}
}

async function importData(): Promise<void> {
	if (!importFile.value || importing.value || !allStopped.value) return;
	importing.value = true;
	transferError.value = '';
	try {
		importResult.value = await api.data.import(importFile.value.content, importPassword.value || undefined);
		importFile.value = undefined;
		if (importFileInput.value) importFileInput.value.value = '';
		await loadAll();
		const current = JSON.stringify(service.settings?.ocs ?? {}, null, 2);
		draft.value = current;
		baseline.value = current;
		toast('配置已导入', 'ok');
	} catch (error) {
		transferError.value = describeError(error);
	} finally {
		importing.value = false;
		importConfirm.value = false;
		importPassword.value = '';
	}
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

	<section class="panel transfer-panel">
		<header class="panel__head">
			<span class="panel__title">配置迁移</span><span class="tag tag--dim">.ocsdata</span>
		</header>
		<div class="transfer-grid">
			<form
				class="transfer-form"
				@submit.prevent="exportData"
			>
				<h2>加密导出</h2>
				<p class="field__hint">包含实例配置、账号密码、用户脚本和平台设置。使用此密码可在其他服务器恢复。</p>
				<label class="field"
					><span class="field__label">导出密码</span
					><span class="field__control"
						><input
							v-model="exportPassword"
							type="password"
							autocomplete="new-password"
							maxlength="1024"
							aria-label="导出密码"
							:disabled="exporting"
							required /></span
				></label>
				<BaseButton
					type="submit"
					:busy="exporting"
					:disabled="!exportPassword.trim()"
					>下载加密配置</BaseButton
				>
			</form>
			<div class="transfer-form">
				<h2>导入配置</h2>
				<p class="field__hint">
					导入会替换现有配置，需先停止全部实例。浏览器 profile、Cookie 和下载文件通过数据目录备份迁移。
				</p>
				<label class="field"
					><span class="field__label">选择 .ocsdata 文件</span
					><span class="field__control"
						><input
							ref="importFileInput"
							type="file"
							accept=".ocsdata,.json,application/json"
							aria-label="导入配置文件"
							:disabled="importing"
							@change="selectImport" /></span
				></label>
				<p
					v-if="importFile"
					class="field__hint"
				>
					{{ importFile.name }} · {{ formatBytes(importFile.size) }}<br />{{ importFile.format }}
				</p>
				<label
					v-if="importFile?.encrypted"
					class="field"
					><span class="field__label">原导出密码</span
					><span class="field__control"
						><input
							v-model="importPassword"
							type="password"
							autocomplete="off"
							maxlength="1024"
							aria-label="原导出密码"
							:disabled="importing" /></span
				></label>
				<p
					v-if="!allStopped"
					class="field__hint"
				>
					请停止全部实例后导入。
				</p>
				<BaseButton
					:busy="importing"
					:disabled="!importFile || !allStopped || (importFile.encrypted && !importPassword)"
					@click="importConfirm = true"
					>查看并确认导入</BaseButton
				>
			</div>
		</div>
		<div
			v-if="transferError"
			class="transfer-feedback inline-error"
			role="alert"
		>
			{{ transferError }}
		</div>
		<div
			v-if="importResult"
			class="transfer-feedback"
		>
			<p>已导入 {{ importResult.browsers }} 个实例、{{ importResult.userScripts }} 个用户脚本。</p>
			<ul v-if="importResult.warnings.length">
				<li
					v-for="warning in importResult.warnings"
					:key="warning"
				>
					{{ warning }}
				</li>
			</ul>
		</div>
	</section>
	<ConfirmDialog
		:open="importConfirm"
		title="替换现有配置"
		:message="`将使用「${importFile?.name || ''}」替换现有 ${service.browsers.length} 个实例、${
			service.scripts.length
		} 个脚本与平台设置。`"
		note="建议先下载当前加密配置。桌面导入会获取网络脚本；无法获取或仅引用本地路径的脚本会在结果中列明。已有 profile 与下载文件保留。"
		confirm-text="替换并导入"
		:danger="true"
		:busy="importing"
		@cancel="importConfirm = false"
		@confirm="importData"
	/>

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
.transfer-panel {
	margin-bottom: 18px;
}
.transfer-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 24px;
	padding: 18px;
}
.transfer-form {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 12px;
	min-width: 0;
}
.transfer-form h2 {
	font-size: 13px;
	font-weight: 500;
}
.transfer-form .field {
	width: 100%;
}
.transfer-feedback {
	margin: 0 18px 18px;
	font-size: 12px;
	line-height: 1.7;
	overflow-wrap: anywhere;
}
.transfer-feedback ul {
	margin: 8px 0 0;
	padding-left: 18px;
	color: var(--text-3);
}
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
	.transfer-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
