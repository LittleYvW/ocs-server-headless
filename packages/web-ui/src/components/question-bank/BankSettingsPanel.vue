<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import {
	aiEnabled,
	bank,
	cancelKeyEdit,
	clearKey,
	editKey,
	loadSettings,
	restoreSettingsDraft,
	saveSettings,
	settingsDirty,
	storedKey
} from '@/stores/question-bank';

const draft = computed(() => bank.draft);

const enabledLabel = computed(() => (bank.settings?.enabled ? '查询已启用' : '查询已暂停'));

function save(): void {
	void saveSettings();
}
</script>

<template>
	<section
		v-if="draft"
		class="panel bank-settings"
	>
		<header class="panel__head">
			<div class="head-line">
				<span class="panel__title">Model / Budget</span>
				<span class="tag tag--dim mono">{{ enabledLabel }}</span>
			</div>
			<div class="head-tools">
				<span
					class="tag"
					:class="settingsDirty ? 'tag--warn' : 'tag--dim'"
					>{{ settingsDirty ? '未保存' : '已同步' }}</span
				>
				<BaseButton
					size="sm"
					variant="ghost"
					:disabled="!settingsDirty || bank.settingsSaving"
					@click="restoreSettingsDraft"
					>还原</BaseButton
				>
				<BaseButton
					size="sm"
					variant="primary"
					:busy="bank.settingsSaving"
					:disabled="!settingsDirty"
					@click="save"
					>保存</BaseButton
				>
			</div>
		</header>

		<div class="settings-body">
			<div class="switch-grid">
				<BaseSwitch
					v-model="draft.aiEnabled"
					label="启用 AI 答题"
					>启用 AI 答题
				</BaseSwitch>
				<BaseSwitch
					v-model="draft.autoCache"
					label="自动缓存 AI 答案"
					>自动缓存 AI 答案
				</BaseSwitch>
				<BaseSwitch
					v-model="draft.sameQuestionCheck"
					label="模糊候选交给 AI 判断同题"
					>模糊候选交给 AI 判断同题
				</BaseSwitch>
			</div>

			<div class="divider"></div>

			<div class="form-grid">
				<label class="field">
					<span class="field__label">协议</span>
					<span class="field__control">
						<select
							v-model="draft.model.protocol"
							aria-label="模型协议"
						>
							<option value="openai-chat">openai-chat · /chat/completions</option>
							<option value="openai-response">openai-response · /responses</option>
						</select>
						<span class="field__chevron"></span>
					</span>
				</label>

				<label class="field">
					<span class="field__label">模型 ID</span>
					<span class="field__control">
						<input
							v-model="draft.model.modelId"
							maxlength="200"
							placeholder="服务商的模型标识"
							aria-label="模型 ID"
						/>
					</span>
					<span class="field__hint">不预选模型，也不连接远程模型目录。</span>
				</label>

				<label class="field form-grid__wide">
					<span class="field__label">Base URL</span>
					<span class="field__control">
						<input
							v-model="draft.model.baseUrl"
							maxlength="2000"
							placeholder="https://provider.example/v1"
							spellcheck="false"
							aria-label="模型 Base URL"
						/>
					</span>
					<span class="field__hint">
						填写供应商的协议基础路径，例如带 <span class="mono">/v1</span> 的地址；服务端不会自动补全。
						不允许账号、查询参数、片段或重定向。
					</span>
				</label>

				<div class="field form-grid__wide">
					<span class="field__label">API Key</span>
					<span class="field__control key-control">
						<input
							v-if="bank.keyEditing"
							v-model="bank.keyValue"
							type="password"
							autocomplete="new-password"
							spellcheck="false"
							placeholder="粘贴供应商密钥"
							aria-label="模型 API Key"
						/>
						<span
							v-else
							class="key-state mono"
							:class="{ 'key-state--cleared': bank.keyCleared }"
						>
							{{ bank.keyCleared ? '保存后清除' : storedKey ? '***' : '未设置' }}
						</span>
						<button
							v-if="!bank.keyEditing"
							type="button"
							class="field__action"
							@click="editKey"
						>
							{{ storedKey ? '修改' : '填写' }}
						</button>
						<button
							v-else
							type="button"
							class="field__action"
							@click="cancelKeyEdit"
						>
							取消
						</button>
						<button
							v-if="storedKey && !bank.keyCleared"
							type="button"
							class="field__action"
							@click="clearKey"
						>
							清除
						</button>
					</span>
					<span class="field__hint">
						读取时显示 <span class="mono">***</span>；未修改不提交该字段，明确清除时提交空字符串。
						密钥只保存在服务端加密配置与本页内存中。
					</span>
				</div>

				<label class="field">
					<span class="field__label">总超时</span>
					<span class="field__control">
						<input
							v-model.number="draft.timeoutSeconds"
							type="number"
							min="5"
							max="55"
							step="1"
							aria-label="查询总超时秒数"
						/>
						<span class="field__capsule">SEC</span>
					</span>
					<span class="field__hint">5–55 秒，覆盖查库、同题判断、请求与重试。</span>
				</label>

				<label class="field">
					<span class="field__label">重试次数</span>
					<span class="field__control">
						<input
							v-model.number="draft.retryCount"
							type="number"
							min="0"
							max="2"
							step="1"
							aria-label="重试次数"
						/>
						<span class="field__capsule">TIMES</span>
					</span>
					<span class="field__hint">0–2，仅对瞬时网络、超时与限流重试。</span>
				</label>
			</div>

			<p
				v-if="bank.settingsError"
				class="inline-error settings-error"
				role="alert"
			>
				<AppIcon
					name="warning"
					:size="13"
				/>
				<span>{{ bank.settingsError }}</span>
			</p>
		</div>

		<footer class="panel__foot">
			<span>关闭 AI 后仍可查询本地已有题库。</span>
			<span class="mono">{{ aiEnabled ? 'ai on' : 'ai off' }}</span>
		</footer>
	</section>

	<section
		v-else
		class="panel"
	>
		<div class="empty">
			<span>{{ bank.settingsLoading ? '正在读取设置…' : '尚未读取到题库设置。' }}</span>
			<BaseButton
				size="sm"
				variant="ghost"
				:disabled="bank.settingsLoading"
				@click="loadSettings"
				>重试</BaseButton
			>
		</div>
	</section>
</template>

<style scoped>
.bank-settings {
	margin-bottom: 18px;
}

.head-line {
	display: flex;
	align-items: center;
	gap: 10px;
}

.head-tools {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 8px;
}

.settings-body {
	display: flex;
	flex-direction: column;
	gap: 6px;
	padding: 18px;
}

.switch-grid {
	display: grid;
	grid-template-columns: repeat(3, minmax(0, 1fr));
	gap: 14px 24px;
}

.form-grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 16px 20px;
}

.form-grid__wide {
	grid-column: 1 / -1;
}

.key-control {
	align-items: stretch;
}

.key-state {
	display: inline-flex;
	flex: 1;
	align-items: center;
	padding: 9px 11px;
	font-size: 12px;
	color: var(--text-2);
	letter-spacing: 0.08em;
}

.key-state--cleared {
	color: var(--warn);
}

.settings-error {
	margin-top: 12px;
}

@media (max-width: 900px) {
	.switch-grid,
	.form-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 560px) {
	.head-tools {
		justify-content: flex-start;
	}
}
</style>
