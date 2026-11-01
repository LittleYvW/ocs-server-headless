<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import { queryQuestionBank } from '@/api/question-query';
import type { QueryResult } from '@/api/question-query';
import { bank } from '@/stores/question-bank';
import { describeQueryFailure, formatDuration } from '@/lib/question-bank';
import { toast } from '@/stores/toasts';

const form = reactive({ title: '', options: '', type: '', token: '' });
const result = ref<QueryResult | null>(null);
const formError = ref('');
const busy = ref(false);
const cancelled = ref(false);
let controller: AbortController | undefined;

const canUseIssuedToken = computed(() => !!bank.connection?.client.token);
const outcome = computed(() => {
	const current = result.value;
	if (!current) return null;
	if (current.ok) return { label: '命中', hint: '', tone: 'ok' as const };
	return describeQueryFailure(current);
});

function useIssuedToken(): void {
	const token = bank.connection?.client.token;
	if (token) form.token = token;
}

function clearForm(): void {
	form.title = '';
	form.options = '';
	form.type = '';
	result.value = null;
	cancelled.value = false;
	formError.value = '';
}

async function run(): Promise<void> {
	if (busy.value) return;
	formError.value = '';
	cancelled.value = false;
	if (!form.title.trim()) {
		formError.value = '请输入需查询的题干。';
		return;
	}
	const token = form.token.trim();
	if (!/^[a-f0-9]{64}$/i.test(token)) {
		formError.value = '查询令牌应为 64 位十六进制字符。';
		return;
	}
	busy.value = true;
	result.value = null;
	controller = new AbortController();
	try {
		result.value = await queryQuestionBank(
			{
				title: form.title,
				options: form.options.trim() ? form.options : undefined,
				type: form.type.trim() ? form.type.trim() : undefined
			},
			token,
			{ signal: controller.signal }
		);
	} catch (error) {
		if ((error as DOMException | undefined)?.name === 'AbortError') {
			cancelled.value = true;
			return;
		}
		result.value = {
			ok: false,
			status: 0,
			code: 'NETWORK_ERROR',
			message: error instanceof Error ? error.message : '查询失败。',
			durationMs: 0
		};
	} finally {
		busy.value = false;
		controller = undefined;
	}
}

function cancel(): void {
	controller?.abort();
}

async function copyAnswer(): Promise<void> {
	const answer = result.value?.data?.answer;
	if (!answer) return;
	try {
		await navigator.clipboard.writeText(answer);
		toast('已复制答案', 'ok');
	} catch {
		toast('浏览器拒绝写入剪贴板，请手动选择文本复制。', 'error');
	}
}

onBeforeUnmount(() => controller?.abort());
</script>

<template>
	<div class="query-layout">
		<section class="panel">
			<header class="panel__head">
				<span class="panel__title">Query Probe</span>
				<span class="tag tag--dim mono">/question-bank/query</span>
			</header>
			<form
				class="query-body"
				@submit.prevent="run"
			>
				<label class="field">
					<span class="field__label">题干 <span class="field__required">必填</span></span>
					<span class="field__control">
						<textarea
							v-model="form.title"
							rows="3"
							spellcheck="false"
							aria-label="查询题干"
						></textarea>
					</span>
				</label>
				<label class="field">
					<span class="field__label">选项</span>
					<span class="field__control">
						<textarea
							v-model="form.options"
							rows="3"
							spellcheck="false"
							placeholder="A. 北京&#10;B. 上海"
							aria-label="查询选项"
						></textarea>
					</span>
				</label>
				<label class="field">
					<span class="field__label">题型</span>
					<span class="field__control">
						<input
							v-model="form.type"
							maxlength="100"
							placeholder="可选，例如 single"
							aria-label="查询题型"
						/>
					</span>
				</label>
				<div class="field">
					<span class="field__label">查询令牌</span>
					<span class="field__control">
						<input
							v-model="form.token"
							type="password"
							autocomplete="off"
							spellcheck="false"
							placeholder="64 位十六进制"
							aria-label="查询令牌"
						/>
						<button
							v-if="canUseIssuedToken"
							type="button"
							class="field__action"
							@click="useIssuedToken"
						>
							用本次令牌
						</button>
					</span>
					<span class="field__hint">
						查询使用独立 fetch，不附带管理令牌；401 只表示查询令牌无效，不会退出管理员登录。
					</span>
				</div>

				<p
					v-if="formError"
					class="inline-error"
					role="alert"
				>
					{{ formError }}
				</p>

				<div class="query-actions">
					<BaseButton
						type="submit"
						variant="primary"
						:busy="busy"
						>执行查询</BaseButton
					>
					<BaseButton
						v-if="busy"
						variant="ghost"
						@click="cancel"
						>取消等待</BaseButton
					>
					<BaseButton
						v-else
						variant="ghost"
						:disabled="!result && !cancelled"
						@click="clearForm"
						>清空</BaseButton
					>
					<span
						v-if="busy"
						class="dim small mono"
						>等待结果…</span
					>
				</div>
			</form>
		</section>

		<section class="panel result-panel">
			<header class="panel__head">
				<span class="panel__title">Result</span>
				<span
					v-if="result"
					class="tag mono"
					:class="result.ok ? 'tag--ok' : outcome?.tone === 'warn' ? 'tag--warn' : 'tag--bad'"
					>{{ result.status || '—' }} · {{ formatDuration(result.durationMs) }}</span
				>
			</header>

			<div
				v-if="outcome && result"
				class="result-body"
			>
				<div
					class="outcome"
					:class="`outcome--${outcome.tone}`"
				>
					<span class="outcome__dot"></span>
					<span class="outcome__label">{{ outcome.label }}</span>
					<span
						v-if="!result.ok"
						class="mono outcome__code"
						>{{ result.code }}</span
					>
				</div>
				<p
					v-if="outcome.hint"
					class="outcome__hint"
				>
					{{ outcome.hint }}
				</p>

				<template v-if="result.ok && result.data">
					<section class="answer">
						<div class="answer__head">
							<span class="field__label">答案</span>
							<div class="answer__meta">
								<span
									v-if="result.data.is_ai"
									class="tag tag--warn"
									>AI</span
								>
								<span
									v-if="result.data.is_pending_correction"
									class="tag tag--bad"
									>待修正</span
								>
								<span class="tag tag--dim mono">ID {{ result.data.id }}</span>
								<button
									type="button"
									class="icon-btn"
									title="复制答案"
									aria-label="复制答案"
									@click="copyAnswer"
								>
									<AppIcon
										name="file"
										:size="12"
									/>
								</button>
							</div>
						</div>
						<p class="answer__text">{{ result.data.answer }}</p>
					</section>
					<p class="dim small">多选与填空答案保留 <span class="mono">###</span> 原文，不转换为选项字母。</p>
				</template>

				<p class="dim small query-note">本次成功只说明该请求与该令牌可用，不代表所有平台、图片题或题型均已验证。</p>
			</div>

			<div
				v-else-if="cancelled"
				class="empty"
			>
				<span>已停止等待。已接纳的查询仍受服务端预算约束，不承诺撤销已发生的模型调用。</span>
			</div>

			<div
				v-else
				class="empty"
			>
				<span>尚未执行查询。</span>
				<span class="dim small">查询响应等待时间可能较长，按钮会持续到结果、取消或超时。</span>
			</div>
		</section>
	</div>
</template>

<style scoped>
.query-layout {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
	gap: 18px;
	align-items: start;
}

.query-body {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 18px;
}

.query-actions {
	display: flex;
	align-items: center;
	gap: 10px;
	flex-wrap: wrap;
}

.result-body {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 18px;
}

.outcome {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 12px;
}

.outcome__dot {
	width: 5px;
	height: 5px;
	border-radius: 50%;
	background: currentColor;
}

.outcome--ok {
	color: var(--accent);
}

.outcome--warn {
	color: var(--warn);
}

.outcome--bad {
	color: var(--danger);
}

.outcome__label {
	letter-spacing: 0.04em;
}

.outcome__code {
	margin-left: auto;
	font-size: 10px;
	color: var(--text-3);
}

.outcome__hint {
	font-size: 11.5px;
	line-height: 1.6;
	color: var(--text-3);
}

.answer {
	display: flex;
	flex-direction: column;
	gap: 8px;
	padding-left: 12px;
	border-left: 1px solid var(--accent-line);
}

.answer__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	flex-wrap: wrap;
}

.answer__meta {
	display: flex;
	align-items: center;
	gap: 6px;
}

.answer__text {
	font-size: 13.5px;
	line-height: 1.75;
	color: var(--text-1);
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.query-note {
	margin-top: 4px;
	padding-top: 12px;
	border-top: 1px solid var(--line-1);
}

@media (max-width: 1080px) {
	.query-layout {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
