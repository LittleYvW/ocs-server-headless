<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalPanel from '@/components/ModalPanel.vue';
import { bank, createFolder, deleteFolder, renameFolder, setQuestionFolder } from '@/stores/question-bank';
import { folderDepth, folderDescendants, sortedFolders } from '@/lib/question-bank';
import type { QuestionBankFolder } from '@/api/types';

const ordered = computed(() => sortedFolders(bank.folders));

const dialog = ref<{ id: number | null; name: string; parentId: number } | null>(null);
const dialogBusy = ref(false);
const pendingDelete = ref<QuestionBankFolder | null>(null);
const deleting = ref(false);

const parentChoices = computed(() => {
	const blocked = dialog.value?.id != null ? folderDescendants(bank.folders, dialog.value.id) : new Set<number>();
	return ordered.value.filter((folder) => !blocked.has(folder.id));
});

const rows = computed(() => ordered.value.map((folder) => ({ folder, depth: folderDepth(bank.folders, folder.id) })));

function selectFolder(id: number | null): void {
	if (id === bank.questionsFolder) return;
	void setQuestionFolder(id);
}

function openCreate(): void {
	dialog.value = {
		id: null,
		name: '',
		parentId: typeof bank.questionsFolder === 'number' ? bank.questionsFolder : 0
	};
}

function openEdit(folder: QuestionBankFolder): void {
	dialog.value = { id: folder.id, name: folder.name, parentId: folder.parentId };
}

async function submitDialog(): Promise<void> {
	const current = dialog.value;
	if (!current || dialogBusy.value) return;
	const name = current.name.trim();
	if (!name) return;
	dialogBusy.value = true;
	const ok =
		current.id === null
			? await createFolder(name, current.parentId)
			: await renameFolder(current.id, name, current.parentId);
	dialogBusy.value = false;
	if (ok) dialog.value = null;
}

async function confirmDelete(): Promise<void> {
	const target = pendingDelete.value;
	if (!target || deleting.value) return;
	deleting.value = true;
	await deleteFolder(target.id);
	deleting.value = false;
	pendingDelete.value = null;
}
</script>

<template>
	<aside class="folder-rail">
		<header class="folder-rail__head">
			<span class="panel__title">Folders</span>
			<button
				type="button"
				class="icon-btn"
				title="新建文件夹"
				aria-label="新建文件夹"
				@click="openCreate"
			>
				<AppIcon
					name="plus"
					:size="13"
				/>
			</button>
		</header>

		<nav
			class="folder-list"
			aria-label="题目文件夹"
		>
			<button
				type="button"
				class="folder-row folder-row--all"
				:class="{ 'is-active': bank.questionsFolder === null }"
				@click="selectFolder(null)"
			>
				<span class="folder-row__name">全部题目</span>
				<span class="folder-row__count mono">{{ bank.questionsTotal }}</span>
			</button>

			<div
				v-for="row in rows"
				:key="row.folder.id"
				class="folder-row"
				:class="{ 'is-active': bank.questionsFolder === row.folder.id }"
			>
				<button
					type="button"
					class="folder-row__main"
					@click="selectFolder(row.folder.id)"
				>
					<span
						v-for="segment in row.depth"
						:key="segment"
						class="folder-row__segment"
						aria-hidden="true"
					></span>
					<span class="folder-row__name">{{ row.folder.name }}</span>
					<span class="folder-row__count mono">{{ row.folder.questionCount }}</span>
				</button>
				<span
					v-if="row.folder.id !== 0"
					class="folder-row__tools"
				>
					<button
						type="button"
						class="icon-btn icon-btn--tiny"
						title="重命名或移动"
						aria-label="重命名或移动文件夹"
						@click.stop="openEdit(row.folder)"
					>
						<AppIcon
							name="edit"
							:size="12"
						/>
					</button>
					<button
						type="button"
						class="icon-btn icon-btn--tiny icon-btn--danger"
						title="删除空文件夹"
						aria-label="删除文件夹"
						@click.stop="pendingDelete = row.folder"
					>
						<AppIcon
							name="trash"
							:size="12"
						/>
					</button>
				</span>
			</div>

			<p
				v-if="!bank.folders.length"
				class="folder-empty dim"
			>
				{{ bank.foldersLoading ? '正在读取文件夹…' : '暂无文件夹。' }}
			</p>
		</nav>

		<p class="folder-rail__foot dim">计数只统计直接包含的题目，不含子文件夹。</p>

		<ModalPanel
			:open="dialog !== null"
			:title="dialog?.id == null ? '新建文件夹' : '编辑文件夹'"
			kicker="Folder"
			size="narrow"
			@close="dialog = null"
		>
			<div
				v-if="dialog"
				class="stack gap-16"
			>
				<label class="field">
					<span class="field__label">名称</span>
					<span class="field__control">
						<input
							v-model="dialog.name"
							maxlength="200"
							placeholder="例如 计算机网络"
							aria-label="文件夹名称"
							@keydown.enter.prevent="submitDialog"
						/>
					</span>
					<span class="field__hint">最多 200 字节。</span>
				</label>
				<label class="field">
					<span class="field__label">父文件夹</span>
					<span class="field__control">
						<select
							v-model.number="dialog.parentId"
							aria-label="父文件夹"
						>
							<option
								v-for="option in parentChoices"
								:key="option.id"
								:value="option.id"
							>
								{{ option.name }}
							</option>
						</select>
						<span class="field__chevron"></span>
					</span>
					<span class="field__hint">不能选择自身或其后代，服务端也会拒绝循环引用。</span>
				</label>
				<p class="inline-note">默认文件夹 0 不可重命名、移动或删除；它可作为父文件夹。</p>
			</div>
			<template #footer>
				<BaseButton
					variant="ghost"
					:disabled="dialogBusy"
					@click="dialog = null"
					>取消</BaseButton
				>
				<BaseButton
					variant="primary"
					:busy="dialogBusy"
					:disabled="!dialog?.name.trim()"
					@click="submitDialog"
					>保存</BaseButton
				>
			</template>
		</ModalPanel>

		<ConfirmDialog
			:open="pendingDelete !== null"
			title="删除文件夹"
			:message="`将删除空文件夹「${pendingDelete?.name ?? ''}」。`"
			note="仅空文件夹可删除；包含题目或子文件夹时服务端返回 409，不会隐式级联删除。默认文件夹不可删除。"
			confirm-text="删除"
			:danger="true"
			:busy="deleting"
			@cancel="pendingDelete = null"
			@confirm="confirmDelete"
		/>
	</aside>
</template>

<style scoped>
.folder-rail {
	display: flex;
	flex-direction: column;
	min-height: 0;
	border-left: 1px solid var(--line-1);
}

.folder-rail__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 10px;
	padding: 12px 14px;
	border-bottom: 1px solid var(--line-1);
}

.folder-list {
	display: flex;
	flex-direction: column;
	padding: 6px 0;
	overflow-y: auto;
	max-height: 60vh;
}

.folder-row {
	position: relative;
	display: flex;
	align-items: center;
	gap: 2px;
	padding: 0 6px 0 0;
	color: var(--text-2);
	transition: background 0.16s var(--ease), color 0.16s;
}

.folder-row::before {
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

.folder-row.is-active::before {
	height: 58%;
}

.folder-row.is-active {
	color: var(--text-1);
	background: rgba(255, 255, 255, 0.02);
}

.folder-row:hover {
	background: rgba(255, 255, 255, 0.018);
}

.folder-row__main {
	display: flex;
	flex: 1;
	align-items: center;
	gap: 6px;
	min-width: 0;
	padding: 8px 10px;
	border: 0;
	background: none;
	color: inherit;
	font-size: 12px;
	text-align: left;
}

.folder-row--all {
	padding-left: 10px;
	border: 0;
	background: none;
	color: inherit;
	font-size: 12px;
	text-align: left;
}

.folder-row--all:focus-visible,
.folder-row__main:focus-visible {
	outline: 1px solid var(--accent-line);
	outline-offset: -1px;
}

.folder-row--all .folder-row__name {
	flex: 1;
	padding: 8px 0;
	font-size: 12px;
}

.folder-row__segment {
	width: 9px;
	align-self: stretch;
	border-left: 1px solid var(--line-1);
	opacity: 0.9;
}

.folder-row__name {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.folder-row__count {
	font-size: 10px;
	color: var(--text-3);
	font-variant-numeric: tabular-nums;
}

.folder-row__tools {
	display: flex;
	gap: 2px;
	opacity: 0;
	transition: opacity 0.16s;
}

.folder-row:hover .folder-row__tools,
.folder-row:focus-within .folder-row__tools {
	opacity: 1;
}

.icon-btn--tiny {
	width: 22px;
	height: 22px;
}

.folder-empty {
	padding: 10px 14px;
	font-size: 11px;
}

.folder-rail__foot {
	padding: 12px 14px;
	border-top: 1px solid var(--line-1);
	font-size: 10.5px;
	line-height: 1.5;
}

@media (max-width: 1080px) {
	.folder-rail {
		border-left: 0;
		border-top: 1px solid var(--line-1);
	}

	.folder-list {
		max-height: 220px;
	}
}
</style>
