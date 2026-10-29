<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PageHead from '@/components/PageHead.vue';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import { splitMatches, validateMatches } from '@/lib/config';
import { refreshScripts, service } from '@/stores/service';
import { toast } from '@/stores/toasts';
import type { UserScript } from '@/api/types';

const editingId = ref('');
const name = ref('');
const code = ref('');
const matchesText = ref('');
const enabled = ref(true);
const saving = ref(false);
const formError = ref('');
const deleting = ref(false);
const discardOpen = ref(false);
const pendingSelect = ref<string | null>(null);
const deleteOpen = ref(false);
const initialized = ref(false);
const baseline = ref(fieldsSignature());

const isNew = computed(() => !editingId.value);
const current = computed(() => service.scripts.find((item) => item.id === editingId.value));
const enabledCount = computed(() => service.scripts.filter((item) => item.enabled).length);
const dirty = computed(() => fieldsSignature() !== baseline.value);

function fieldsSignature(): string {
	return JSON.stringify({ name: name.value, code: code.value, matchesText: matchesText.value, enabled: enabled.value });
}

function snapshot(): void {
	baseline.value = fieldsSignature();
}

function applySelection(id: string | null): void {
	const script = id ? service.scripts.find((item) => item.id === id) : undefined;
	editingId.value = script?.id || '';
	name.value = script?.name || '';
	code.value = script?.code || '';
	matchesText.value = (script?.matches || []).join('\n');
	enabled.value = script?.enabled ?? true;
	formError.value = '';
	snapshot();
}

function attemptSelect(id: string | null): void {
	if (dirty.value) {
		pendingSelect.value = id;
		discardOpen.value = true;
		return;
	}
	applySelection(id);
}

function discardAndSelect(): void {
	discardOpen.value = false;
	applySelection(pendingSelect.value);
	pendingSelect.value = null;
}

function startNew(): void {
	attemptSelect(null);
}

async function save(): Promise<void> {
	if (saving.value) return;
	formError.value = '';
	const trimmed = name.value.trim();
	if (!trimmed) {
		formError.value = '请输入脚本名称。';
		return;
	}
	if (trimmed.length > 200) {
		formError.value = '名称不能超过 200 个字符。';
		return;
	}
	const matches = splitMatches(matchesText.value);
	const matchesError = validateMatches(matches);
	if (matchesError) {
		formError.value = matchesError;
		return;
	}
	if (!code.value.trim()) {
		formError.value = '请输入脚本代码。';
		return;
	}
	if (code.value.length > 250000) {
		formError.value = '代码不能超过 250000 个字符。';
		return;
	}
	saving.value = true;
	const creating = !editingId.value;
	try {
		const payload = { name: trimmed, code: code.value, matches, enabled: enabled.value };
		const saved: UserScript = editingId.value
			? await api.scripts.update(editingId.value, payload)
			: await api.scripts.create(payload);
		editingId.value = saved.id;
		name.value = saved.name;
		code.value = saved.code;
		matchesText.value = saved.matches.join('\n');
		enabled.value = saved.enabled;
		snapshot();
		await refreshScripts(true);
		toast(creating ? '脚本已创建，重启关联实例后生效' : '脚本已保存，重启关联实例后生效', 'ok');
	} catch (error) {
		formError.value = describeError(error);
	} finally {
		saving.value = false;
	}
}

function askDelete(): void {
	if (isNew.value) return;
	deleteOpen.value = true;
}

async function confirmDelete(): Promise<void> {
	if (!editingId.value || deleting.value) return;
	deleting.value = true;
	try {
		await api.scripts.remove(editingId.value);
		toast('脚本已删除', 'ok');
		deleteOpen.value = false;
		editingId.value = '';
		await refreshScripts(true);
		applySelection(service.scripts[0]?.id ?? null);
	} catch (error) {
		deleteOpen.value = false;
		formError.value = describeError(error);
		toast(formError.value, 'error');
	} finally {
		deleting.value = false;
	}
}

watch(
	() => service.scripts,
	(list) => {
		if (!initialized.value) {
			initialized.value = true;
			if (list.length) applySelection(list[0].id);
			return;
		}
		if (editingId.value && !list.some((item) => item.id === editingId.value)) {
			applySelection(list[0]?.id ?? null);
			return;
		}
		if (!editingId.value && !dirty.value && !name.value && !code.value && list.length) {
			applySelection(list[0].id);
		}
	},
	{ immediate: true }
);
</script>

<template>
	<PageHead
		kicker="Scripts / 03"
		title="用户脚本"
		note="普通 JavaScript 在匹配页面的 DOMContentLoaded 注入；仅 * 为通配符，不提供 GM_* API。"
	>
		<template #actions>
			<BaseButton
				variant="primary"
				@click="startNew"
			>
				<AppIcon
					name="plus"
					:size="14"
				/>
				新建脚本
			</BaseButton>
		</template>
	</PageHead>

	<div class="scripts-layout">
		<section class="panel list-panel">
			<header class="panel__head">
				<span class="panel__title">Files</span>
				<span class="dim small">{{ service.scripts.length }}</span>
			</header>
			<div
				v-if="!service.scripts.length"
				class="empty"
			>
				尚未创建用户脚本。
			</div>
			<div
				v-else
				class="script-list"
			>
				<button
					v-for="script in service.scripts"
					:key="script.id"
					type="button"
					class="script-item"
					:class="{ 'is-active': script.id === editingId }"
					@click="attemptSelect(script.id)"
				>
					<span
						class="script-item__dot"
						:class="{ 'is-on': script.enabled }"
					></span>
					<span class="script-item__body">
						<span class="script-item__name truncate">{{ script.name }}</span>
						<span class="script-item__meta mono">
							{{ script.matches.length }} 条匹配 · {{ script.updatedAt.slice(0, 10) }}
						</span>
					</span>
				</button>
			</div>
			<footer class="panel__foot">
				<span>{{ enabledCount }} 个已启用</span>
				<button
					type="button"
					class="text-action"
					@click="startNew"
				>
					新建
				</button>
			</footer>
		</section>

		<section class="panel editor-panel">
			<header class="panel__head">
				<div class="editor-title">
					<span class="panel__title">{{ isNew ? 'New Script' : 'Edit Script' }}</span>
					<span
						v-if="dirty"
						class="tag tag--warn"
						>未保存</span
					>
					<span
						v-else-if="!isNew"
						class="tag tag--dim mono"
						>{{ editingId.slice(0, 8) }}</span
					>
				</div>
				<div class="editor-tools">
					<span class="dim small mono">{{ code.length }} chars</span>
					<BaseButton
						size="sm"
						variant="primary"
						:busy="saving"
						:disabled="!dirty"
						@click="save"
						>保存</BaseButton
					>
					<button
						type="button"
						class="icon-btn icon-btn--danger"
						title="删除脚本"
						:disabled="isNew"
						@click="askDelete"
					>
						<AppIcon
							name="trash"
							:size="14"
						/>
					</button>
				</div>
			</header>

			<form
				class="editor"
				@submit.prevent="save"
				@keydown.ctrl.s.prevent="save"
				@keydown.meta.s.prevent="save"
			>
				<div class="editor-meta">
					<label class="field field--name">
						<span class="field__label">脚本名称 <span class="field__required">*</span></span>
						<span class="field__control">
							<input
								v-model="name"
								maxlength="200"
								placeholder="例如：教务系统自动跳转"
								autocomplete="off"
							/>
						</span>
					</label>
					<BaseSwitch
						v-model="enabled"
						label="启用脚本"
						>启用</BaseSwitch
					>
				</div>

				<label class="field">
					<span class="field__label">URL 匹配 <span class="field__required">*</span></span>
					<span class="field__control">
						<textarea
							v-model="matchesText"
							rows="3"
							spellcheck="false"
							placeholder="https://example.com/*&#10;https://sub.example.com/path*"
						></textarea>
					</span>
					<span class="field__hint">逐行填写；https://*.example.com/* 不自动匹配根域。</span>
				</label>

				<label class="field">
					<span class="field__label">代码 <span class="field__required">*</span></span>
					<span class="field__control">
						<textarea
							v-model="code"
							class="code-editor"
							rows="17"
							spellcheck="false"
							placeholder="// 普通 JavaScript，在匹配页面 DOMContentLoaded 时执行。"
						></textarea>
					</span>
				</label>

				<p
					v-if="formError"
					class="inline-error"
				>
					{{ formError }}
				</p>

				<div class="editor-foot">
					<span class="dim small">保存后需重启关联实例生效；删除被引用脚本会返回冲突。</span>
					<BaseButton
						type="submit"
						variant="primary"
						:busy="saving"
						>保存脚本</BaseButton
					>
				</div>
			</form>

			<footer class="panel__foot">
				<span>代码仅在浏览器页面上下文执行，不是服务端脚本上传接口。</span>
				<span class="mono">ctrl + s</span>
			</footer>
		</section>
	</div>

	<ConfirmDialog
		:open="discardOpen"
		title="放弃未保存的修改"
		message="当前脚本有未保存的修改，继续切换会丢失这些内容。"
		confirm-text="放弃并切换"
		:danger="true"
		@cancel="discardOpen = false"
		@confirm="discardAndSelect"
	/>

	<ConfirmDialog
		:open="deleteOpen"
		title="删除用户脚本"
		:message="`确定删除「${current?.name || name}」吗？`"
		note="如果有实例仍引用该脚本，服务端会返回 409，需要先停止实例并解除关联。"
		confirm-text="删除脚本"
		:danger="true"
		:busy="deleting"
		@cancel="deleteOpen = false"
		@confirm="confirmDelete"
	/>
</template>

<style scoped>
.scripts-layout {
	display: grid;
	grid-template-columns: 292px minmax(0, 1fr);
	gap: 18px;
	align-items: start;
}

.list-panel {
	position: sticky;
	top: 24px;
}

.script-list {
	display: flex;
	flex-direction: column;
	max-height: 58vh;
	overflow-y: auto;
}

.script-item {
	position: relative;
	display: flex;
	align-items: flex-start;
	gap: 10px;
	padding: 11px 16px;
	border: 0;
	border-top: 1px solid var(--line-1);
	background: transparent;
	text-align: left;
	transition: background 0.14s;
}

.script-item:first-child {
	border-top: 0;
}

.script-item::before {
	content: '';
	position: absolute;
	left: 0;
	top: 50%;
	width: 1px;
	height: 0;
	background: var(--accent);
	transform: translateY(-50%);
	transition: height 0.2s var(--ease);
}

.script-item:hover {
	background: rgba(255, 255, 255, 0.02);
}

.script-item.is-active {
	background: rgba(255, 255, 255, 0.025);
}

.script-item.is-active::before {
	height: 24px;
}

.script-item__dot {
	width: 5px;
	height: 5px;
	margin-top: 6px;
	flex: none;
	border-radius: 50%;
	background: var(--text-3);
}

.script-item__dot.is-on {
	background: var(--accent);
}

.script-item__body {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.script-item__name {
	font-size: 12px;
	color: var(--text-2);
}

.script-item.is-active .script-item__name {
	color: var(--text-1);
}

.script-item__meta {
	font-size: 9px;
	color: var(--text-3);
	letter-spacing: 0.03em;
}

.text-action {
	border: 0;
	background: none;
	padding: 0;
	font-size: 11px;
	color: var(--text-3);
}

.text-action:hover {
	color: var(--accent);
}

.editor-panel {
	min-width: 0;
}

.editor-title {
	display: flex;
	align-items: center;
	gap: 10px;
}

.editor-tools {
	display: flex;
	align-items: center;
	gap: 10px;
}

.editor {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 18px;
}

.editor-meta {
	display: flex;
	align-items: flex-end;
	gap: 22px;
}

.field--name {
	flex: 1;
}

.code-editor {
	min-height: 340px;
	font-size: 12px;
	line-height: 1.7;
	tab-size: 2;
}

.editor-foot {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding-top: 4px;
}

@media (max-width: 980px) {
	.scripts-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.list-panel {
		position: static;
	}

	.script-list {
		max-height: 220px;
	}
}

@media (max-width: 620px) {
	.editor-panel .panel__head {
		flex-wrap: wrap;
		row-gap: 8px;
	}

	.editor-tools .dim {
		display: none;
	}

	.editor-meta {
		flex-direction: column;
		align-items: stretch;
	}

	.editor-foot {
		flex-direction: column;
		align-items: flex-start;
	}
}
</style>
