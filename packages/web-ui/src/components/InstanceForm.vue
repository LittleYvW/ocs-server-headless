<script setup lang="ts">
import { service } from '@/stores/service';
import { computed, reactive, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import ModalPanel from '@/components/ModalPanel.vue';
import { describeError } from '@/api/errors';
import type { AutomationDefinition, BrowserView, ConfigDefinition, UserScript } from '@/api/types';
import { isVisible, normalizeUrl, validateConfig } from '@/lib/config';
import { saveBrowser } from '@/stores/service';
import { toast } from '@/stores/toasts';

const props = defineProps<{
	open: boolean;
	profile: BrowserView | null;
	definitions: AutomationDefinition[];
	scripts: UserScript[];
}>();

const emit = defineEmits<{ close: []; saved: [browser: BrowserView] }>();

interface DraftEntry {
	name: string;
	configs: Record<string, unknown>;
	definition: AutomationDefinition;
}

const name = ref('');
const group = ref('');
const tagsText = ref('');
const notes = ref('');
const startUrl = ref('');
const entries = ref<DraftEntry[]>([]);
const scriptIds = ref<string[]>([]);
const addName = ref('');
const saving = ref(false);
const formError = ref('');
const errors = reactive<Record<string, string>>({});

const editing = computed(() => !!props.profile);
const available = computed(() =>
	props.definitions.filter((item) => !entries.value.some((entry) => entry.name === item.name))
);

function definitionOf(entryName: string): AutomationDefinition | undefined {
	return props.definitions.find((item) => item.name === entryName);
}

function reset(): void {
	name.value = props.profile?.name || '';
	group.value = props.profile?.group || '';
	tagsText.value = (props.profile?.tags || []).join(', ');
	notes.value = props.profile?.notes || '';
	startUrl.value = props.profile?.startUrl || 'https://example.com/';
	scriptIds.value = [...(props.profile?.userScriptIds || [])];
	entries.value = (props.profile?.automationScripts || [])
		.map((entry) => {
			const definition = definitionOf(entry.name);
			if (!definition) return null;
			const configs: Record<string, unknown> = {};
			for (const [key, config] of Object.entries(definition.configs)) {
				configs[key] = entry.configs[key] ?? config.value;
			}
			return { name: entry.name, configs, definition };
		})
		.filter((entry): entry is DraftEntry => !!entry);
	addName.value = '';
	formError.value = '';
	Object.keys(errors).forEach((key) => delete errors[key]);
}

watch(
	() => [props.open, props.profile?.id],
	() => {
		if (props.open) reset();
	}
);

function entryFields(entry: DraftEntry): [string, ConfigDefinition][] {
	return Object.entries(entry.definition.configs).filter(
		([, config]) => !config.hide && isVisible(config, entry.configs)
	);
}

function fieldError(index: number, key: string): string {
	return errors[`${index}:${key}`] || '';
}

function clearFieldError(index: number, key: string): void {
	delete errors[`${index}:${key}`];
}

function addEntry(): void {
	const definition = definitionOf(addName.value);
	if (!definition || entries.value.length >= 20) return;
	const configs: Record<string, unknown> = {};
	for (const [key, config] of Object.entries(definition.configs)) {
		configs[key] =
			typeof config.value === 'object' && config.value !== null
				? JSON.parse(JSON.stringify(config.value))
				: config.value;
	}
	entries.value.push({ name: definition.name, configs, definition });
	addName.value = '';
}

function removeEntry(index: number): void {
	entries.value.splice(index, 1);
}

function textValue(value: unknown): string {
	return value === undefined || value === null ? '' : String(value);
}

function setText(entry: DraftEntry, key: string, event: Event): void {
	const target = event.target as HTMLInputElement | HTMLTextAreaElement;
	entry.configs[key] = target.value;
}

function setNumber(entry: DraftEntry, key: string, event: Event): void {
	const target = event.target as HTMLInputElement;
	entry.configs[key] = target.value === '' ? '' : Number(target.value);
}

function setSelect(entry: DraftEntry, key: string, config: ConfigDefinition, event: Event): void {
	const target = event.target as HTMLSelectElement;
	entry.configs[key] = config.options?.[target.selectedIndex]?.value;
}

function toggleScript(id: string): void {
	const index = scriptIds.value.indexOf(id);
	if (index === -1) scriptIds.value.push(id);
	else scriptIds.value.splice(index, 1);
}

function originalPassword(entryName: string, key: string): boolean {
	const original = props.profile?.automationScripts.find((item) => item.name === entryName);
	return original?.configs[key] === '***';
}

function validate(): boolean {
	Object.keys(errors).forEach((key) => delete errors[key]);
	formError.value = '';
	const trimmed = name.value.trim();
	if (!trimmed) errors.name = '请输入实例名称。';
	else if (trimmed.length > 200) errors.name = '名称不能超过 200 个字符。';
	const normalized = normalizeUrl(startUrl.value);
	if (!normalized) errors.startUrl = '请输入起始地址。';
	else {
		try {
			const parsed = new URL(normalized);
			if (!['http:', 'https:'].includes(parsed.protocol)) errors.startUrl = '仅支持 http / https 地址。';
			else if (parsed.username || parsed.password) errors.startUrl = '地址不能包含用户名或密码。';
		} catch {
			errors.startUrl = '地址格式不正确。';
		}
	}
	entries.value.forEach((entry, index) => {
		for (const [key, config] of Object.entries(entry.definition.configs)) {
			if (config.hide || !isVisible(config, entry.configs)) continue;
			const message = validateConfig(config, entry.configs[key]);
			if (message) errors[`${index}:${key}`] = message;
		}
	});
	return !Object.keys(errors).length;
}

async function submit(): Promise<void> {
	if (saving.value) return;
	if (!validate()) {
		formError.value = '请先修正标记的字段。';
		return;
	}
	saving.value = true;
	try {
		const saved = await saveBrowser(props.profile?.id || null, {
			name: name.value.trim(),
			group: group.value.trim(),
			tags: tagsText.value
				.split(/[,，]/)
				.map((tag) => tag.trim())
				.filter(Boolean),
			notes: notes.value,
			startUrl: normalizeUrl(startUrl.value),
			automationScripts: entries.value.map((entry) => ({ name: entry.name, configs: entry.configs })),
			userScriptIds: [...scriptIds.value]
		});
		toast(editing.value ? '实例配置已保存' : '实例已创建', 'ok');
		emit('saved', saved);
		emit('close');
	} catch (error) {
		formError.value = describeError(error);
	} finally {
		saving.value = false;
	}
}
</script>

<template>
	<ModalPanel
		:open="open"
		:title="editing ? '编辑实例' : '新建实例'"
		kicker="Instance"
		size="wide"
		:close-on-mask="!saving"
		@close="emit('close')"
	>
		<form
			class="instance-form"
			@submit.prevent="submit"
		>
			<div class="form-grid">
				<label
					class="field"
					:class="{ 'is-invalid': errors.name }"
				>
					<span class="field__label">实例名称 <span class="field__required">*</span></span>
					<span class="field__control">
						<input
							v-model="name"
							maxlength="200"
							placeholder="例如：教务系统 A"
							autocomplete="off"
						/>
					</span>
					<span
						v-if="errors.name"
						class="field__error"
						>{{ errors.name }}</span
					>
				</label>
				<label
					class="field"
					:class="{ 'is-invalid': errors.startUrl }"
				>
					<span class="field__label">起始地址 <span class="field__required">*</span></span>
					<span class="field__control">
						<input
							v-model="startUrl"
							maxlength="4096"
							placeholder="https://example.com"
							spellcheck="false"
							autocomplete="off"
							@blur="startUrl = normalizeUrl(startUrl)"
						/>
					</span>
					<span
						v-if="errors.startUrl"
						class="field__error"
						>{{ errors.startUrl }}</span
					>
					<span
						v-else
						class="field__hint"
						>支持省略 https:// 的域名写法。</span
					>
				</label>
			</div>

			<div class="form-grid">
				<label class="field"
					><span class="field__label">分组</span
					><span class="field__control"
						><input
							v-model="group"
							maxlength="500"
							placeholder="例如：课程 / 第一组" /></span
				></label>
				<label class="field"
					><span class="field__label">标签</span
					><span class="field__control"
						><input
							v-model="tagsText"
							maxlength="3030"
							placeholder="多个标签用逗号分隔" /></span
				></label>
			</div>
			<label class="field"
				><span class="field__label">备注</span
				><span class="field__control">
					<textarea
						v-model="notes"
						maxlength="10000"
						rows="2"
					></textarea></span
			></label>
			<div class="divider"></div>

			<section class="form-section">
				<header class="form-section__head">
					<div>
						<span class="panel__title">内置自动化</span>
						<p class="field__hint">启动实例后按顺序执行；running 不代表自动化已完成。</p>
					</div>
					<div
						v-if="available.length && entries.length < 20"
						class="auto-add"
					>
						<span class="field__control auto-add__control">
							<select
								v-model="addName"
								aria-label="选择自动化程序"
							>
								<option value="">选择程序</option>
								<option
									v-for="item in available"
									:key="item.name"
									:value="item.name"
								>
									{{ item.name }}
								</option>
							</select>
							<span class="field__chevron"></span>
						</span>
						<BaseButton
							size="sm"
							:disabled="!addName"
							@click="addEntry"
						>
							<AppIcon
								name="plus"
								:size="12"
							/>
							添加
						</BaseButton>
					</div>
				</header>

				<p
					v-if="!entries.length"
					class="empty-line"
				>
					未配置自动化程序，启动后仅打开起始地址。
				</p>

				<div
					v-else
					class="auto-list"
				>
					<div
						v-for="(entry, index) in entries"
						:key="entry.name"
						class="auto-block"
					>
						<header class="auto-block__head">
							<div class="auto-block__title">
								<span class="auto-block__index mono">{{ String(index + 1).padStart(2, '0') }}</span>
								<span>{{ entry.name }}</span>
							</div>
							<button
								type="button"
								class="icon-btn icon-btn--danger"
								title="移除"
								@click="removeEntry(index)"
							>
								<AppIcon
									name="trash"
									:size="14"
								/>
							</button>
						</header>

						<p
							v-if="entry.definition.needOCR"
							class="dim small"
							role="note"
						>
							此程序可能需要验证码识别。{{
								service.system?.ocrAvailable ? '服务已配置 OCR。' : '尚未配置 OCR，遇到验证码时登录可能失败。'
							}}
						</p>

						<div class="auto-block__fields">
							<template
								v-for="[key, config] in entryFields(entry)"
								:key="key"
							>
								<div
									class="field"
									:class="{ 'is-invalid': fieldError(index, key), 'field--wide': config.type === 'textarea' }"
								>
									<span class="field__label">
										{{ config.label }}
										<span
											v-if="config.required"
											class="field__required"
											>*</span
										>
									</span>

									<BaseSwitch
										v-if="config.type === 'switch'"
										:model-value="!!entry.configs[key]"
										:label="config.label"
										@update:model-value="entry.configs[key] = $event"
									/>

									<span
										v-else-if="config.type === 'select'"
										class="field__control"
									>
										<select
											:value="entry.configs[key]"
											@change="
												setSelect(entry, key, config, $event);
												clearFieldError(index, key);
											"
										>
											<option
												v-for="option in config.options || []"
												:key="String(option.value)"
												:value="option.value"
											>
												{{ option.label }}
											</option>
										</select>
										<span class="field__chevron"></span>
									</span>

									<span
										v-else-if="config.type === 'password' && entry.configs[key] === '***'"
										class="field__control"
									>
										<input
											type="text"
											value="已保存 · 不修改"
											disabled
										/>
										<button
											type="button"
											class="field__action field__action--text"
											@click="entry.configs[key] = ''"
										>
											修改
										</button>
									</span>

									<span
										v-else-if="config.type === 'password'"
										class="field__control"
									>
										<input
											type="password"
											:value="textValue(entry.configs[key])"
											autocomplete="new-password"
											:placeholder="config.placeholder || '输入新密码'"
											@input="setText(entry, key, $event)"
										/>
										<button
											v-if="originalPassword(entry.name, key)"
											type="button"
											class="field__action field__action--text"
											title="恢复为已保存的密码"
											@click="entry.configs[key] = '***'"
										>
											保留原值
										</button>
									</span>

									<span
										v-else-if="config.type === 'textarea'"
										class="field__control"
									>
										<textarea
											:value="textValue(entry.configs[key])"
											:placeholder="config.placeholder"
											:maxlength="config.max"
											@input="setText(entry, key, $event)"
										></textarea>
									</span>

									<span
										v-else
										class="field__control"
									>
										<input
											:type="config.type === 'number' ? 'number' : 'text'"
											:value="textValue(entry.configs[key])"
											:placeholder="config.placeholder"
											:maxlength="config.type === 'number' ? undefined : config.max"
											:min="config.min"
											:max="config.max"
											spellcheck="false"
											autocomplete="off"
											@input="config.type === 'number' ? setNumber(entry, key, $event) : setText(entry, key, $event)"
										/>
									</span>

									<span
										v-if="fieldError(index, key)"
										class="field__error"
										>{{ fieldError(index, key) }}</span
									>
									<span
										v-else-if="config.placeholder && config.type !== 'password'"
										class="field__hint"
									>
										{{ config.placeholder }}
									</span>
								</div>
							</template>
						</div>
					</div>
				</div>
			</section>

			<div class="divider"></div>

			<section class="form-section">
				<header class="form-section__head">
					<div>
						<span class="panel__title">用户脚本关联</span>
						<p class="field__hint">
							仅启用的关联脚本会运行；普通 JS 按 URL 匹配注入，标准用户脚本由管理器提供 GM API 并按元数据执行。
						</p>
					</div>
				</header>
				<p
					v-if="!scripts.length"
					class="empty-line"
				>
					尚未创建用户脚本。
				</p>
				<div
					v-else
					class="script-grid"
				>
					<label
						v-for="script in scripts"
						:key="script.id"
						class="check script-check"
					>
						<input
							type="checkbox"
							:checked="scriptIds.includes(script.id)"
							@change="toggleScript(script.id)"
						/>
						<span class="script-check__body">
							<span class="script-check__name">{{ script.name }}</span>
							<span class="script-check__meta mono">
								{{ script.enabled ? '启用' : '停用' }} · {{ script.matches.length }} 条匹配
							</span>
						</span>
					</label>
				</div>
			</section>

			<div
				v-if="formError"
				class="inline-error form-error"
			>
				{{ formError }}
			</div>
		</form>

		<template #footer>
			<span
				v-if="editing"
				class="modal__foot-note"
				>保存后需重启实例生效</span
			>
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
			>
				{{ editing ? '保存配置' : '创建实例' }}
			</BaseButton>
		</template>
	</ModalPanel>
</template>

<style scoped>
.instance-form {
	display: flex;
	flex-direction: column;
	gap: 4px;
}

.form-grid {
	display: grid;
	grid-template-columns: minmax(0, 1fr) minmax(0, 1.35fr);
	gap: 18px;
}

.form-section {
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.form-section__head {
	display: flex;
	align-items: flex-start;
	justify-content: space-between;
	gap: 18px;
	flex-wrap: wrap;
}

.form-section__head .field__hint {
	margin-top: 5px;
}

.auto-add {
	display: flex;
	align-items: center;
	gap: 8px;
}

.auto-add__control {
	min-width: 176px;
}

.auto-add__control select {
	padding: 7px 28px 7px 10px;
	font-size: 12px;
}

.empty-line {
	padding: 18px;
	border: 1px dashed var(--line-1);
	font-size: 12px;
	color: var(--text-3);
}

.auto-list {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.auto-block {
	border: 1px solid var(--line-1);
	background: rgba(255, 255, 255, 0.012);
}

.auto-block__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding: 9px 10px 9px 14px;
	border-bottom: 1px solid var(--line-1);
}

.auto-block__title {
	display: flex;
	align-items: baseline;
	gap: 10px;
	font-size: 12px;
	color: var(--text-1);
}

.auto-block__index {
	font-size: 9px;
	color: var(--accent);
	letter-spacing: 0.08em;
}

.auto-block__fields {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
	gap: 16px;
	padding: 16px;
}

.field--wide {
	grid-column: 1 / -1;
}

.field__action--text {
	font-size: 10.5px;
	letter-spacing: 0.04em;
	white-space: nowrap;
}

.script-grid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
	gap: 8px;
}

.script-check {
	padding: 9px 11px;
	border: 1px solid var(--line-1);
	transition: border-color 0.16s;
}

.script-check:hover {
	border-color: var(--line-2);
}

.script-check__body {
	display: flex;
	flex-direction: column;
	gap: 2px;
	min-width: 0;
}

.script-check__name {
	font-size: 12px;
	color: var(--text-1);
}

.script-check__meta {
	font-size: 9.5px;
	color: var(--text-3);
	letter-spacing: 0.04em;
}

.form-error {
	margin-top: 6px;
}

@media (max-width: 700px) {
	.form-grid {
		grid-template-columns: minmax(0, 1fr);
	}
}
</style>
