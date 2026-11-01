<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import { bank, importQuestions, retryItemsFrom } from '@/stores/question-bank';
import type { ImportOutcome } from '@/stores/question-bank';
import { hasFieldErrors, planImportBatches, sortedFolders, validateQuestionInput } from '@/lib/question-bank';
import { formatBytes } from '@/lib/format';
import type { QuestionInput } from '@/api/types';

interface ParsedRow {
	index: number;
	input: QuestionInput;
	target: boolean;
}

interface ParsedFile {
	name: string;
	size: number;
	rows: ParsedRow[];
	issues: { index: number; message: string }[];
}

const fileInput = ref<HTMLInputElement>();
const parsed = ref<ParsedFile | null>(null);
const parseError = ref('');
const targetFolder = ref(0);
const importing = ref(false);
const progress = ref({ done: 0, total: 0 });
interface ImportRun {
	items: QuestionInput[];
	outcome: ImportOutcome;
}

const runs = ref<ImportRun[]>([]);
const importError = ref('');
let selection = 0;

const folderChoices = computed(() => sortedFolders(bank.folders));

const plan = computed(() => (parsed.value ? planImportBatches(parsed.value.rows.map((row) => row.input)) : null));

const totals = computed(() => {
	let inserted = 0;
	let skipped = 0;
	let failed = 0;
	for (const run of runs.value) {
		inserted += run.outcome.inserted;
		skipped += run.outcome.skipped;
		failed += run.outcome.batches.filter((batch) => !batch.ok).length;
	}
	return { inserted, skipped, failed };
});

const remaining = computed(() => {
	const last = runs.value[runs.value.length - 1];
	if (!last?.outcome.stopped) return [];
	return retryItemsFrom(last.outcome, last.items);
});

const canSubmit = computed(
	() => !!parsed.value && parsed.value.issues.length === 0 && parsed.value.rows.length > 0 && !importing.value
);

function clearFile(): void {
	parsed.value = null;
	parseError.value = '';
	runs.value = [];
	importError.value = '';
	progress.value = { done: 0, total: 0 };
	if (fileInput.value) fileInput.value.value = '';
}

/** Re-reads the current target folder into records that omitted folderId. */
function applyTarget(): void {
	const current = parsed.value;
	if (!current) return;
	for (const row of current.rows) {
		if (row.target) row.input.folderId = targetFolder.value;
	}
}

function inspect(value: unknown, index: number): { row?: ParsedRow; issue?: { index: number; message: string } } {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		return { issue: { index, message: '记录必须是对象。' } };
	const record = value as Record<string, unknown>;
	const allowed = ['question', 'options', 'answer', 'questionType', 'folderId', 'isAi', 'isPendingCorrection'];
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length) return { issue: { index, message: `包含不支持的字段：${unknown.join(', ')}。` } };
	if (typeof record.question !== 'string') return { issue: { index, message: 'question 必须是字符串。' } };
	if (typeof record.answer !== 'string') return { issue: { index, message: 'answer 必须是字符串。' } };
	if (record.options !== undefined && record.options !== null && typeof record.options !== 'string')
		return { issue: { index, message: 'options 必须是字符串或 null。' } };
	if (record.questionType !== undefined && record.questionType !== null && typeof record.questionType !== 'string')
		return { issue: { index, message: 'questionType 必须是字符串或 null。' } };
	if (record.folderId !== undefined && (!Number.isInteger(record.folderId) || (record.folderId as number) < 0))
		return { issue: { index, message: 'folderId 必须是非负整数。' } };
	if (record.isAi !== undefined && typeof record.isAi !== 'boolean')
		return { issue: { index, message: 'isAi 必须是布尔值。' } };
	if (record.isPendingCorrection !== undefined && typeof record.isPendingCorrection !== 'boolean')
		return { issue: { index, message: 'isPendingCorrection 必须是布尔值。' } };
	const input: QuestionInput = {
		question: record.question,
		options: (record.options as string | null | undefined) ?? null,
		answer: record.answer,
		questionType: (record.questionType as string | null | undefined) ?? null,
		folderId: (record.folderId as number | undefined) ?? targetFolder.value,
		isAi: (record.isAi as boolean | undefined) ?? false,
		isPendingCorrection: (record.isPendingCorrection as boolean | undefined) ?? false
	};
	const fieldErrors = validateQuestionInput(input);
	if (hasFieldErrors(fieldErrors)) {
		return { issue: { index, message: Object.values(fieldErrors)[0] as string } };
	}
	return { row: { index, input, target: record.folderId === undefined } };
}

async function chooseFile(event: Event): Promise<void> {
	const current = ++selection;
	const file = (event.target as HTMLInputElement).files?.[0];
	parsed.value = null;
	parseError.value = '';
	runs.value = [];
	importError.value = '';
	parseError.value = '';
	if (!file) return;
	if (file.size > 20 * 1024 * 1024) {
		parseError.value = '文件不得超过 20 MiB，请拆分成更小的文件。';
		return;
	}
	try {
		const text = await file.text();
		if (current !== selection) return;
		const payload = JSON.parse(text) as unknown;
		if (!payload || typeof payload !== 'object' || Array.isArray(payload))
			throw new Error('顶层必须是 {"questions":[...]} 对象。');
		const questions = (payload as { questions?: unknown }).questions;
		if (!Array.isArray(questions)) throw new Error('缺少 questions 数组。');
		const rows: ParsedRow[] = [];
		const issues: { index: number; message: string }[] = [];
		questions.forEach((entry, index) => {
			const result = inspect(entry, index + 1);
			if (result.row) rows.push(result.row);
			if (result.issue) issues.push(result.issue);
		});
		parsed.value = { name: file.name, size: file.size, rows, issues };
	} catch (error) {
		parseError.value =
			error instanceof SyntaxError ? '文件不是有效 JSON。' : error instanceof Error ? error.message : '无法读取文件。';
	}
}

async function submit(): Promise<void> {
	if (!canSubmit.value || !parsed.value) return;
	importing.value = true;
	importError.value = '';
	progress.value = { done: 0, total: plan.value?.batches.length ?? 0 };
	try {
		const items = parsed.value.rows.map((row) => row.input);
		const outcome = await importQuestions(items, (done, total) => {
			progress.value = { done, total };
		});
		runs.value.push({ items, outcome });
	} catch (error) {
		importError.value = error instanceof Error ? error.message : '导入失败。';
	} finally {
		importing.value = false;
	}
}

async function retry(): Promise<void> {
	const items = remaining.value;
	if (!items.length || importing.value) return;
	importing.value = true;
	importError.value = '';
	try {
		const outcome = await importQuestions(items, (done, total) => {
			progress.value = { done, total };
		});
		runs.value.push({ items, outcome });
	} catch (error) {
		importError.value = error instanceof Error ? error.message : '重试失败。';
	} finally {
		importing.value = false;
	}
}

function onTargetChange(): void {
	applyTarget();
}
</script>

<template>
	<div class="import-layout">
		<section class="panel">
			<header class="panel__head">
				<span class="panel__title">Import / JSON</span>
				<span class="tag tag--dim mono">≤ 500 / 1 MiB</span>
			</header>
			<div class="import-body">
				<label class="field">
					<span class="field__label">选择 JSON 文件</span>
					<span class="field__control">
						<input
							ref="fileInput"
							type="file"
							accept=".json,application/json"
							aria-label="选择导入文件"
							:disabled="importing"
							@change="chooseFile"
						/>
					</span>
					<span class="field__hint">
						文件只在浏览器读取，不提交本地路径。接受规范的
						<span class="mono">{ questions: [...] }</span>，字段与题目表单一致。
					</span>
				</label>

				<label class="field">
					<span class="field__label">目标文件夹</span>
					<span class="field__control">
						<select
							v-model.number="targetFolder"
							aria-label="导入目标文件夹"
							:disabled="importing"
							@change="onTargetChange"
						>
							<option
								v-for="folder in folderChoices"
								:key="folder.id"
								:value="folder.id"
							>
								{{ folder.name }}
							</option>
						</select>
						<span class="field__chevron"></span>
					</span>
					<span class="field__hint">只作用于未指定 folderId 的记录；带 folderId 的记录保持原值。</span>
				</label>

				<p
					v-if="parseError"
					class="inline-error"
					role="alert"
				>
					{{ parseError }}
				</p>

				<p class="inline-note import-note">
					<AppIcon
						name="warning"
						:size="13"
					/>
					<span> 不宣称兼容桌面文档、Excel、PDF 或任意 ZError 导出格式；旧 SQLite 题库的迁移由部署文档处理。 </span>
				</p>
			</div>
		</section>

		<section
			v-if="parsed"
			class="panel"
		>
			<header class="panel__head">
				<div class="head-line">
					<span class="panel__title">Preview</span>
					<span class="tag tag--dim mono">{{ parsed.name }}</span>
				</div>
				<span class="dim small mono">{{ formatBytes(parsed.size) }}</span>
			</header>

			<div class="preview-grid">
				<div class="preview-cell">
					<span class="metric__label">记录</span>
					<span class="preview-value mono">{{ parsed.rows.length + parsed.issues.length }}</span>
				</div>
				<div class="preview-cell">
					<span class="metric__label">可导入</span>
					<span class="preview-value mono preview-value--ok">{{ parsed.rows.length }}</span>
				</div>
				<div class="preview-cell">
					<span class="metric__label">错误行</span>
					<span
						class="preview-value mono"
						:class="{ 'preview-value--bad': parsed.issues.length }"
						>{{ parsed.issues.length }}</span
					>
				</div>
				<div class="preview-cell">
					<span class="metric__label">批次</span>
					<span class="preview-value mono">{{ plan?.batches.length ?? 0 }}</span>
				</div>
			</div>

			<div
				v-if="parsed.issues.length"
				class="issue-list"
			>
				<p class="issue-list__head">
					<AppIcon
						name="warning"
						:size="13"
					/>
					<span>存在错误行时不允许提交：任一记录无效都会让整批回滚。</span>
				</p>
				<ul>
					<li
						v-for="issue in parsed.issues.slice(0, 20)"
						:key="issue.index"
					>
						<span class="mono issue-index">#{{ issue.index }}</span>
						<span>{{ issue.message }}</span>
					</li>
				</ul>
				<p
					v-if="parsed.issues.length > 20"
					class="dim small"
				>
					仅显示前 20 条错误。
				</p>
			</div>

			<footer class="panel__foot import-foot">
				<span class="dim small">
					每批最多 500 条、编码后不超过 1 MiB
					<template v-if="plan?.batches.length">
						· 最大批次 {{ formatBytes(Math.max(...plan.batches.map((batch) => batch.bytes))) }}
					</template>
				</span>
				<div class="foot-actions">
					<BaseButton
						size="sm"
						variant="ghost"
						:disabled="importing"
						@click="clearFile"
						>清除</BaseButton
					>
					<BaseButton
						size="sm"
						variant="primary"
						:busy="importing"
						:disabled="!canSubmit"
						@click="submit"
					>
						提交 {{ parsed.rows.length }} 条
					</BaseButton>
				</div>
			</footer>

			<div
				v-if="importing"
				class="progress"
			>
				<div class="progress__line">
					<span
						class="progress__fill"
						:style="{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }"
					></span>
				</div>
				<span class="dim small mono"
					>{{ progress.done }} / {{ progress.total }} 批 · 已写入 {{ totals.inserted }} 条</span
				>
			</div>

			<div
				v-if="runs.length"
				class="results"
			>
				<div class="results__head">
					<span class="panel__title">Result</span>
					<span class="dim small mono">
						新增 {{ totals.inserted }} · 跳过 {{ totals.skipped }}
						<template v-if="totals.failed"> · 失败批次 {{ totals.failed }}</template>
					</span>
				</div>
				<div class="rows">
					<div
						v-for="(run, runIndex) in runs"
						:key="runIndex"
						class="run"
					>
						<div
							v-for="batch in run.outcome.batches"
							:key="`${runIndex}-${batch.index}`"
							class="run__row"
						>
							<span class="mono">#{{ batch.index + 1 }}</span>
							<span class="mono dim">{{ batch.count }} 条</span>
							<span
								v-if="batch.ok"
								class="tag tag--ok"
								>新增 {{ batch.inserted }} · 跳过 {{ batch.skipped }}</span
							>
							<span
								v-else
								class="tag tag--bad"
								>失败</span
							>
							<span
								v-if="batch.error"
								class="run__error"
								>{{ batch.error }}</span
							>
						</div>
					</div>
				</div>
				<p class="inline-note run-note">
					<AppIcon
						name="warning"
						:size="13"
					/>
					<span> 多批导入之间没有跨批事务：已成功批次不会因后续失败回滚，也不会在离开页面后自动撤销。 </span>
				</p>
				<div
					v-if="remaining.length"
					class="foot-actions retry"
				>
					<BaseButton
						size="sm"
						variant="line"
						:busy="importing"
						@click="retry"
						>从失败批重试（{{ remaining.length }} 条）</BaseButton
					>
				</div>
			</div>

			<p
				v-if="importError"
				class="inline-error import-error"
				role="alert"
			>
				{{ importError }}
			</p>
		</section>
	</div>
</template>

<style scoped>
.import-layout {
	display: grid;
	grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.1fr);
	gap: 18px;
	align-items: start;
}

.import-body {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 18px;
}

.import-note {
	align-items: flex-start;
}

.head-line {
	display: flex;
	align-items: center;
	gap: 10px;
	min-width: 0;
}

.preview-grid {
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	border-bottom: 1px solid var(--line-1);
}

.preview-cell {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 14px 18px;
	border-left: 1px solid var(--line-1);
}

.preview-cell:first-child {
	border-left: 0;
	padding-left: 18px;
}

.preview-value {
	font-size: 22px;
	font-weight: 200;
	line-height: 1;
	font-variant-numeric: tabular-nums;
}

.preview-value--ok {
	color: var(--accent);
}

.preview-value--bad {
	color: var(--danger);
}

.issue-list {
	padding: 14px 18px;
	border-bottom: 1px solid var(--line-1);
}

.issue-list__head {
	display: flex;
	align-items: center;
	gap: 8px;
	font-size: 11.5px;
	color: var(--danger);
}

.issue-list ul {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 10px 0 0;
	padding: 0;
	list-style: none;
	font-size: 11px;
	color: var(--text-2);
}

.issue-list li {
	display: flex;
	gap: 10px;
}

.issue-index {
	color: var(--text-3);
	min-width: 34px;
}

.import-foot {
	flex-wrap: wrap;
}

.foot-actions {
	display: flex;
	gap: 8px;
}

.progress {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding: 14px 18px;
	border-bottom: 1px solid var(--line-1);
}

.progress__line {
	position: relative;
	height: 1px;
	background: var(--line-1);
}

.progress__fill {
	position: absolute;
	left: 0;
	top: 0;
	height: 1px;
	background: var(--accent);
	transition: width 0.3s var(--ease);
}

.results {
	border-top: 1px solid var(--line-1);
}

.results__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 14px 18px 10px;
}

.run__row {
	display: grid;
	grid-template-columns: 34px 66px 108px minmax(0, 1fr);
	align-items: center;
	gap: 10px;
	padding: 8px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11px;
}

.run__row:first-child {
	border-top: 0;
}

.run__error {
	color: var(--danger);
	font-size: 11px;
	overflow-wrap: anywhere;
}

.run-note {
	margin: 14px 18px;
	align-items: flex-start;
}

.retry {
	padding: 0 18px 16px;
}

.import-error {
	margin: 0 18px 16px;
}

@media (max-width: 1080px) {
	.import-layout {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 620px) {
	.preview-grid {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}

	.run__row {
		grid-template-columns: 30px 60px minmax(0, 1fr);
	}

	.run__error {
		grid-column: 1 / -1;
	}
}
</style>
