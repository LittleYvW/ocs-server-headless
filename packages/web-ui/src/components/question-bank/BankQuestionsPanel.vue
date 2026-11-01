<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import ModalPanel from '@/components/ModalPanel.vue';
import BankFolderRail from './BankFolderRail.vue';
import BankQuestionForm from './BankQuestionForm.vue';
import {
	bank,
	deleteQuestion,
	loadQuestions,
	refreshQuestion,
	setQuestionLimit,
	setQuestionPage,
	setQuestionQuery,
	totalPages
} from '@/stores/question-bank';
import { questionFolderName, questionStemPreview, sqliteUtcToIso } from '@/lib/question-bank';
import { formatStamp, relativeTime } from '@/lib/format';
import type { QuestionBankQuestion } from '@/api/types';

const detail = ref<QuestionBankQuestion | null>(null);
const editorOpen = ref(false);
const editing = ref<QuestionBankQuestion | null>(null);
const pendingDelete = ref<QuestionBankQuestion | null>(null);
const deleting = ref(false);

const pages = computed(() => totalPages());
const deleteLabel = computed(() => {
	const record = pendingDelete.value;
	if (!record) return '';
	const stem = questionStemPreview(record);
	return stem.length > 40 ? `${stem.slice(0, 40)}…` : stem;
});
const activeFolder = computed(() =>
	bank.questionsFolder === null ? '全部题目' : questionFolderName(bank.folders, bank.questionsFolder)
);
const rangeLabel = computed(() => {
	if (!bank.questionsTotal) return '暂无记录';
	const start = (bank.questionsPage - 1) * bank.questionsLimit + 1;
	const end = Math.min(bank.questionsTotal, bank.questionsPage * bank.questionsLimit);
	return `${start}–${end} / ${bank.questionsTotal}`;
});

function openDetail(record: QuestionBankQuestion): void {
	detail.value = record;
	void refreshQuestion(record.id).then((fresh) => {
		if (fresh && detail.value?.id === fresh.id) detail.value = fresh;
	});
}

function openCreate(): void {
	editing.value = null;
	editorOpen.value = true;
}

function openEdit(record: QuestionBankQuestion): void {
	editing.value = record;
	editorOpen.value = true;
	detail.value = null;
}

async function confirmDelete(): Promise<void> {
	const target = pendingDelete.value;
	if (!target || deleting.value) return;
	deleting.value = true;
	const ok = await deleteQuestion(target.id);
	deleting.value = false;
	pendingDelete.value = null;
	if (ok && detail.value?.id === target.id) detail.value = null;
}

function askDelete(record: QuestionBankQuestion): void {
	pendingDelete.value = record;
}

function onSearch(event: Event): void {
	setQuestionQuery((event.target as HTMLInputElement).value);
}
</script>

<template>
	<div class="questions-layout">
		<section class="panel questions-panel">
			<header class="panel__head questions-head">
				<div class="search">
					<label class="mini-field">
						<span class="mini-field__label mono">Search</span>
						<span class="field__control mini-field__control">
							<input
								:value="bank.questionsQuery"
								type="search"
								maxlength="200"
								placeholder="按题干搜索（子串匹配）"
								aria-label="搜索题干"
								@input="onSearch"
							/>
						</span>
					</label>
					<span class="scope mono">{{ activeFolder }}</span>
				</div>
				<div class="head-tools">
					<BaseButton
						size="sm"
						variant="ghost"
						title="重新读取当前页"
						:busy="bank.questionsLoading"
						@click="loadQuestions()"
					>
						<AppIcon
							name="refresh"
							:size="13"
						/>
					</BaseButton>
					<BaseButton
						size="sm"
						variant="primary"
						@click="openCreate"
					>
						<AppIcon
							name="plus"
							:size="13"
						/>
						新建题目
					</BaseButton>
				</div>
			</header>

			<p
				v-if="bank.questionsError"
				class="inline-error table-note"
				role="alert"
			>
				{{ bank.questionsError }}
			</p>

			<div class="table-head q-grid">
				<span>#</span>
				<span>题干</span>
				<span class="q-tags">标记</span>
				<span class="q-folder">文件夹</span>
				<span class="q-time">创建</span>
				<span aria-hidden="true"></span>
			</div>

			<div
				v-if="bank.questions.length"
				class="rows"
			>
				<div
					v-for="(record, index) in bank.questions"
					:key="record.id"
					class="row q-grid q-row"
					role="button"
					tabindex="0"
					@click="openDetail(record)"
					@keydown.enter.prevent="openDetail(record)"
				>
					<span class="mono q-index">{{
						String((bank.questionsPage - 1) * bank.questionsLimit + index + 1).padStart(2, '0')
					}}</span>
					<span class="q-stem">{{ questionStemPreview(record) }}</span>
					<span class="q-tags">
						<span
							v-if="record.isPendingCorrection"
							class="tag tag--bad"
							>待修正</span
						>
						<span
							v-else-if="record.isAi"
							class="tag tag--warn"
							>AI</span
						>
						<span
							v-else
							class="tag tag--dim"
							>本地</span
						>
					</span>
					<span class="q-folder dim truncate">{{ questionFolderName(bank.folders, record.folderId) }}</span>
					<span class="q-time dim mono">{{ formatStamp(sqliteUtcToIso(record.createdAt)) }}</span>
					<span class="q-actions">
						<button
							type="button"
							class="icon-btn"
							title="编辑"
							aria-label="编辑题目"
							@click.stop="openEdit(record)"
						>
							<AppIcon
								name="edit"
								:size="12"
							/>
						</button>
						<button
							type="button"
							class="icon-btn icon-btn--danger"
							title="删除"
							aria-label="删除题目"
							@click.stop="askDelete(record)"
						>
							<AppIcon
								name="trash"
								:size="12"
							/>
						</button>
					</span>
				</div>
			</div>

			<EmptyState
				v-else
				:text="bank.questionsLoading ? '正在读取题目…' : '当前条件下没有题目。'"
			/>

			<footer class="panel__foot">
				<span class="mono">{{ rangeLabel }}</span>
				<div class="pager">
					<label class="pager__size">
						<span class="dim">每页</span>
						<select
							:value="bank.questionsLimit"
							aria-label="每页条数"
							@change="setQuestionLimit(Number(($event.target as HTMLSelectElement).value))"
						>
							<option :value="20">20</option>
							<option :value="50">50</option>
							<option :value="100">100</option>
						</select>
					</label>
					<button
						type="button"
						class="icon-btn"
						:disabled="bank.questionsPage <= 1 || bank.questionsLoading"
						aria-label="上一页"
						@click="setQuestionPage(bank.questionsPage - 1)"
					>
						<AppIcon
							name="left"
							:size="12"
						/>
					</button>
					<span class="mono pager__count">{{ bank.questionsPage }} / {{ pages }}</span>
					<button
						type="button"
						class="icon-btn"
						:disabled="bank.questionsPage >= pages || bank.questionsLoading"
						aria-label="下一页"
						@click="setQuestionPage(bank.questionsPage + 1)"
					>
						<AppIcon
							name="right"
							:size="12"
						/>
					</button>
				</div>
			</footer>
		</section>

		<BankFolderRail />

		<ModalPanel
			:open="detail !== null"
			title="题目详情"
			kicker="Record"
			size="wide"
			@close="detail = null"
		>
			<div
				v-if="detail"
				class="detail"
			>
				<div class="detail__meta">
					<span class="tag tag--dim mono">ID {{ detail.id }}</span>
					<span class="tag tag--dim">{{ questionFolderName(bank.folders, detail.folderId) }}</span>
					<span
						v-if="detail.isAi"
						class="tag tag--warn"
						>AI</span
					>
					<span
						v-if="detail.isPendingCorrection"
						class="tag tag--bad"
						>待修正</span
					>
					<span class="dim small">{{ relativeTime(sqliteUtcToIso(detail.createdAt)) }}</span>
				</div>

				<section class="detail__block">
					<h3 class="detail__label mono">Question</h3>
					<p class="detail__text">{{ detail.question }}</p>
				</section>

				<section
					v-if="detail.options"
					class="detail__block"
				>
					<h3 class="detail__label mono">Options</h3>
					<p class="detail__text">{{ detail.options }}</p>
				</section>

				<section class="detail__block detail__block--answer">
					<h3 class="detail__label mono">Answer</h3>
					<p class="detail__text">{{ detail.answer }}</p>
				</section>

				<p
					v-if="detail.isPendingCorrection"
					class="inline-note"
				>
					待修正的记录不参与查询；修改答案后可自行清除此标记。
				</p>
			</div>

			<template #footer>
				<span class="dim small">纯文本展示，不渲染 HTML。</span>
				<div class="foot-actions">
					<BaseButton
						variant="danger"
						:disabled="!detail"
						@click="detail && askDelete(detail)"
						>删除</BaseButton
					>
					<BaseButton
						variant="line"
						:disabled="!detail"
						@click="detail && openEdit(detail)"
						>编辑</BaseButton
					>
				</div>
			</template>
		</ModalPanel>

		<BankQuestionForm
			:open="editorOpen"
			:record="editing"
			:default-folder="bank.questionsFolder ?? 0"
			@close="editorOpen = false"
			@saved="editorOpen = false"
		/>

		<ConfirmDialog
			:open="pendingDelete !== null"
			title="删除题目"
			:message="`将删除「${deleteLabel}」。`"
			note="删除不可撤销；若这是当前页最后一条，列表会回退到有效页。"
			confirm-text="删除"
			:danger="true"
			:busy="deleting"
			@cancel="pendingDelete = null"
			@confirm="confirmDelete"
		/>
	</div>
</template>

<style scoped>
.questions-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) 236px;
	gap: 18px;
	align-items: start;
}

.questions-head {
	align-items: flex-end;
	flex-wrap: wrap;
}

.search {
	display: flex;
	align-items: flex-end;
	gap: 14px;
	flex-wrap: wrap;
}

.mini-field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}

.mini-field__label {
	font-size: 8.5px;
	letter-spacing: 0.2em;
	text-transform: uppercase;
	color: var(--text-3);
}

.mini-field__control {
	min-width: 240px;
}

.mini-field__control input {
	padding: 6px 9px;
	font-size: 11.5px;
}

.scope {
	font-size: 10px;
	letter-spacing: 0.08em;
	color: var(--text-3);
	padding-bottom: 8px;
}

.head-tools {
	display: flex;
	align-items: center;
	gap: 8px;
}

.table-note {
	margin: 12px 18px 0;
}

.q-grid {
	grid-template-columns: 34px minmax(0, 1fr) 74px 108px 74px 56px;
}

.q-head {
	padding-bottom: 10px;
}

.q-row {
	padding: 12px 18px;
	cursor: pointer;
}

.q-row:focus-visible {
	outline: 1px solid var(--accent-line);
	outline-offset: -1px;
}

.q-index {
	font-size: 10px;
	color: var(--text-3);
	font-variant-numeric: tabular-nums;
}

.q-stem {
	display: -webkit-box;
	-webkit-line-clamp: 2;
	-webkit-box-orient: vertical;
	overflow: hidden;
	font-size: 12.5px;
	line-height: 1.5;
	color: var(--text-1);
	overflow-wrap: anywhere;
}

.q-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.q-folder,
.q-time {
	font-size: 10.5px;
}

.q-actions {
	display: flex;
	justify-content: flex-end;
	gap: 2px;
	opacity: 0;
	transition: opacity 0.16s;
}

.q-row:hover .q-actions,
.q-row:focus-within .q-actions {
	opacity: 1;
}

.pager {
	display: flex;
	align-items: center;
	gap: 8px;
}

.pager__size {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	margin-right: 6px;
}

.pager__size select {
	padding: 2px 4px;
	border: 1px solid var(--line-2);
	background: transparent;
	color: var(--text-2);
	font-family: var(--font-mono);
	font-size: 10px;
}

.pager__count {
	font-size: 10px;
	color: var(--text-3);
	min-width: 44px;
	text-align: center;
}

.detail {
	display: flex;
	flex-direction: column;
	gap: 18px;
}

.detail__meta {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
}

.detail__block {
	display: flex;
	flex-direction: column;
	gap: 7px;
	padding-left: 12px;
	border-left: 1px solid var(--line-1);
}

.detail__block--answer {
	border-left-color: var(--accent-line);
}

.detail__label {
	font-size: 9px;
	letter-spacing: 0.22em;
	text-transform: uppercase;
	color: var(--text-3);
	font-weight: 400;
}

.detail__text {
	font-size: 13px;
	line-height: 1.7;
	color: var(--text-1);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.foot-actions {
	display: flex;
	gap: 8px;
}

@media (max-width: 1080px) {
	.questions-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.q-grid {
		grid-template-columns: 30px minmax(0, 1fr) 74px 74px 56px;
	}

	.q-folder {
		display: none;
	}
}

@media (max-width: 620px) {
	.q-grid {
		grid-template-columns: 26px minmax(0, 1fr) 68px 52px;
	}

	.q-time {
		display: none;
	}

	.mini-field__control {
		min-width: 160px;
	}
}
</style>
