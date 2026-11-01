<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import ModalPanel from '@/components/ModalPanel.vue';
import { bank, saveQuestion } from '@/stores/question-bank';
import {
	BANK_LIMITS,
	hasFieldErrors,
	sortedFolders,
	toQuestionInput,
	utf8Bytes,
	validateQuestionInput
} from '@/lib/question-bank';
import type { FieldErrors } from '@/lib/question-bank';
import type { QuestionBankQuestion } from '@/api/types';

const props = withDefaults(
	defineProps<{
		open: boolean;
		record?: QuestionBankQuestion | null;
		defaultFolder?: number;
	}>(),
	{ record: null, defaultFolder: 0 }
);

const emit = defineEmits<{ close: []; saved: [record: QuestionBankQuestion] }>();

const form = reactive({
	question: '',
	options: '',
	answer: '',
	questionType: '',
	folderId: 0,
	isAi: false,
	isPendingCorrection: false
});

const errors = ref<FieldErrors>({});
const saveError = ref('');
const saving = ref(false);
const initialAnswer = ref('');

const editing = computed(() => props.record !== null);
const answerChanged = computed(() => editing.value && form.answer !== initialAnswer.value);

watch(
	() => props.open,
	(open) => {
		if (!open) return;
		const record = props.record;
		form.question = record?.question ?? '';
		form.options = record?.options ?? '';
		form.answer = record?.answer ?? '';
		form.questionType = record?.questionType ?? '';
		form.folderId = record?.folderId ?? props.defaultFolder ?? 0;
		form.isAi = record?.isAi ?? false;
		form.isPendingCorrection = record?.isPendingCorrection ?? false;
		initialAnswer.value = form.answer;
		errors.value = {};
		saveError.value = '';
		saving.value = false;
	}
);

const folderOptions = computed(() => {
	const list = sortedFolders(bank.folders).map((folder) => ({ id: folder.id, name: folder.name }));
	if (!list.some((folder) => folder.id === form.folderId)) {
		list.unshift({ id: form.folderId, name: `文件夹 ${form.folderId}` });
	}
	return list;
});

const counters = computed(() => ({
	question: utf8Bytes(form.question),
	options: utf8Bytes(form.options),
	answer: utf8Bytes(form.answer),
	questionType: utf8Bytes(form.questionType)
}));

async function submit(): Promise<void> {
	if (saving.value) return;
	const input = toQuestionInput(form);
	errors.value = validateQuestionInput(input);
	saveError.value = '';
	if (hasFieldErrors(errors.value)) return;
	saving.value = true;
	try {
		const saved = await saveQuestion(props.record?.id ?? null, input);
		emit('saved', saved);
		emit('close');
	} catch (error) {
		saveError.value = error instanceof Error ? error.message : '保存失败。';
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<ModalPanel
		:open="open"
		:title="editing ? '编辑题目' : '新建题目'"
		kicker="Question"
		size="wide"
		:close-on-mask="!saving"
		@close="emit('close')"
	>
		<form
			class="question-form"
			@submit.prevent="submit"
		>
			<label
				class="field"
				:class="{ 'is-invalid': errors.question }"
			>
				<span class="field__label">题干 <span class="field__required">必填</span></span>
				<span class="field__control">
					<textarea
						v-model="form.question"
						rows="3"
						spellcheck="false"
						aria-label="题干"
					></textarea>
				</span>
				<span class="byte-row">
					<span
						v-if="errors.question"
						class="field__error"
						>{{ errors.question }}</span
					>
					<span class="byte-count mono">{{ counters.question }} / {{ BANK_LIMITS.question }}</span>
				</span>
			</label>

			<label
				class="field"
				:class="{ 'is-invalid': errors.options }"
			>
				<span class="field__label">选项</span>
				<span class="field__control">
					<textarea
						v-model="form.options"
						rows="4"
						spellcheck="false"
						placeholder="A. 北京&#10;B. 上海"
						aria-label="选项"
					></textarea>
				</span>
				<span class="byte-row">
					<span
						v-if="errors.options"
						class="field__error"
						>{{ errors.options }}</span
					>
					<span class="byte-count mono">{{ counters.options }} / {{ BANK_LIMITS.options }}</span>
				</span>
			</label>

			<label
				class="field"
				:class="{ 'is-invalid': errors.answer }"
			>
				<span class="field__label">答案 <span class="field__required">必填</span></span>
				<span class="field__control">
					<textarea
						v-model="form.answer"
						rows="3"
						spellcheck="false"
						placeholder="多选与填空使用 ### 分隔"
						aria-label="答案"
					></textarea>
				</span>
				<span class="byte-row">
					<span
						v-if="errors.answer"
						class="field__error"
						>{{ errors.answer }}</span
					>
					<span class="byte-count mono">{{ counters.answer }} / {{ BANK_LIMITS.answer }}</span>
				</span>
			</label>

			<div class="form-row">
				<label
					class="field"
					:class="{ 'is-invalid': errors.questionType }"
				>
					<span class="field__label">题型</span>
					<span class="field__control">
						<input
							v-model="form.questionType"
							maxlength="100"
							placeholder="可选，例如 single"
							aria-label="题型"
						/>
					</span>
					<span
						v-if="errors.questionType"
						class="field__error"
						>{{ errors.questionType }}</span
					>
				</label>

				<label
					class="field"
					:class="{ 'is-invalid': errors.folderId }"
				>
					<span class="field__label">文件夹</span>
					<span class="field__control">
						<select
							v-model.number="form.folderId"
							aria-label="目标文件夹"
						>
							<option
								v-for="folder in folderOptions"
								:key="folder.id"
								:value="folder.id"
							>
								{{ folder.name }}
							</option>
						</select>
						<span class="field__chevron"></span>
					</span>
					<span
						v-if="errors.folderId"
						class="field__error"
						>{{ errors.folderId }}</span
					>
				</label>
			</div>

			<div class="toggles">
				<BaseSwitch
					v-model="form.isAi"
					label="标记为 AI 来源"
					>AI 来源标记
				</BaseSwitch>
				<BaseSwitch
					v-model="form.isPendingCorrection"
					label="标记为待修正"
					>待修正（不参与查询）
				</BaseSwitch>
			</div>

			<p
				v-if="answerChanged"
				class="inline-note"
			>
				<AppIcon
					name="warning"
					:size="13"
				/>
				<span>答案已修改：是否同时清除“待修正”标记由你决定，不会自动更改。</span>
			</p>

			<p
				v-if="saveError"
				class="inline-error"
				role="alert"
			>
				{{ saveError }}
			</p>

			<p class="form-note dim">保存使用完整字段提交；题干、选项与答案按 UTF-8 字节校验，中文按实际编码长度计算。</p>
		</form>

		<template #footer>
			<span class="dim small">{{ editing ? `ID ${record?.id ?? ''}` : '新记录' }}</span>
			<div class="foot-actions">
				<BaseButton
					variant="ghost"
					:disabled="saving"
					@click="emit('close')"
					>取消</BaseButton
				>
				<BaseButton
					variant="primary"
					:busy="saving"
					@click="submit"
					>保存</BaseButton
				>
			</div>
		</template>
	</ModalPanel>
</template>

<style scoped>
.question-form {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.form-row {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px;
}

.toggles {
	display: flex;
	flex-wrap: wrap;
	gap: 22px;
}

.byte-row {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 12px;
}

.byte-count {
	font-size: 10px;
	color: var(--text-3);
	font-variant-numeric: tabular-nums;
	margin-left: auto;
}

.form-note {
	font-size: 11px;
	line-height: 1.6;
}

.foot-actions {
	display: flex;
	gap: 8px;
}

@media (max-width: 560px) {
	.form-row {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
