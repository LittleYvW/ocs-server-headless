<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import PageHead from '@/components/PageHead.vue';
import ModalPanel from '@/components/ModalPanel.vue';
import { api } from '@/api/endpoints';
import { saveBlob } from '@/api/client';
import { describeError } from '@/api/errors';
import { splitMatches, validateMatches } from '@/lib/config';
import { refreshScripts, service } from '@/stores/service';
import { toast } from '@/stores/toasts';
import type { UserScript, ScriptUpdateCheck, CatalogProvider, CatalogScript, CatalogVersion } from '@/api/types';

const editingId = ref('');
const name = ref('');
const code = ref('');
const matchesText = ref('');
const enabled = ref(true);
const mode = ref<'plain' | 'userscript'>('plain');
const sourceUrl = ref('');
const updateUrl = ref('');
const pinned = ref(false);
const saving = ref(false);
const formError = ref('');
const deleting = ref(false);
const discardOpen = ref(false);
const pendingSelect = ref<string | null>(null);
const deleteOpen = ref(false);
const initialized = ref(false);
const importOpen = ref(false);
const importType = ref<'url' | 'file' | 'catalog'>('url');
const importUrl = ref('');
const importCode = ref('');
const importFilename = ref('');
const importError = ref('');
const importing = ref(false);
const checking = ref(false);
const updating = ref(false);
const downloading = ref(false);
const updateCheck = ref<ScriptUpdateCheck | null>(null);
const updateOpen = ref(false);
const catalogProvider = ref<CatalogProvider>('official');
const catalogQuery = ref('');
const catalogPage = ref(1);
const catalogItems = ref<CatalogScript[]>([]);
const catalogLoading = ref(false);
const catalogError = ref('');
const selectedCatalog = ref<CatalogScript | null>(null);
const catalogVersions = ref<CatalogVersion[]>([]);
const versionsLoading = ref(false);
const selectedVersionUrl = ref('');
let catalogRequest = 0;
let versionsRequest = 0;
const baseline = ref(fieldsSignature());

const isNew = computed(() => !editingId.value);
const current = computed(() => service.scripts.find((item) => item.id === editingId.value));
const enabledCount = computed(() => service.scripts.filter((item) => item.enabled).length);
const dirty = computed(() => fieldsSignature() !== baseline.value);

function fieldsSignature(): string {
	return JSON.stringify({
		name: name.value,
		code: code.value,
		matchesText: matchesText.value,
		enabled: enabled.value,
		mode: mode.value,
		sourceUrl: sourceUrl.value,
		updateUrl: updateUrl.value,
		pinned: pinned.value
	});
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
	mode.value = script?.mode || 'plain';
	sourceUrl.value = script?.sourceUrl || '';
	updateUrl.value = script?.updateUrl || '';
	pinned.value = script?.pinned ?? !!(script?.sourceUrl && new URL(script.sourceUrl).searchParams.get('version'));
	updateCheck.value = null;
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
	if (pendingSelect.value === '$import') {
		applySelection(editingId.value || null);
		openImport();
	} else applySelection(pendingSelect.value);
	pendingSelect.value = null;
}

function openImport(): void {
	importError.value = '';
	importOpen.value = true;
}

function startImport(): void {
	if (dirty.value) {
		pendingSelect.value = '$import';
		discardOpen.value = true;
	} else openImport();
}

async function chooseFile(event: Event): Promise<void> {
	const file = (event.target as HTMLInputElement).files?.[0];
	importCode.value = '';
	importFilename.value = '';
	importError.value = '';
	if (!file) return;
	if (file.size > 2 * 1024 * 1024) {
		importError.value = '文件不能超过 2 MiB。';
		return;
	}
	try {
		importCode.value = await file.text();
		importFilename.value = file.name;
	} catch {
		importError.value = '无法读取所选文件。';
	}
}

async function loadCatalog(page = 1): Promise<void> {
	const requestId = ++catalogRequest;
	catalogLoading.value = true;
	catalogError.value = '';
	selectedCatalog.value = null;
	catalogVersions.value = [];
	selectedVersionUrl.value = '';
	versionsRequest++;
	versionsLoading.value = false;
	try {
		const result = await api.scripts.catalog(catalogProvider.value, catalogQuery.value.trim(), page);
		if (requestId !== catalogRequest) return;
		catalogItems.value = result.items;
		catalogPage.value = result.page;
	} catch (error) {
		if (requestId === catalogRequest) {
			catalogError.value = describeError(error);
			catalogItems.value = [];
		}
	} finally {
		if (requestId === catalogRequest) catalogLoading.value = false;
	}
}

async function selectCatalog(script: CatalogScript): Promise<void> {
	const requestId = ++versionsRequest;
	selectedCatalog.value = script;
	catalogVersions.value = [];
	selectedVersionUrl.value = '';
	catalogError.value = '';
	if (catalogProvider.value === 'official') return;
	versionsLoading.value = true;
	try {
		const versions = await api.scripts.versions(catalogProvider.value, script.id, script.name);
		if (requestId === versionsRequest) catalogVersions.value = versions;
	} catch (error) {
		if (requestId === versionsRequest) catalogError.value = describeError(error);
	} finally {
		if (requestId === versionsRequest) versionsLoading.value = false;
	}
}

watch([importOpen, importType, catalogProvider], () => {
	if (importOpen.value && importType.value === 'catalog') void loadCatalog();
});

async function importScript(): Promise<void> {
	if (importing.value) return;
	importError.value = '';
	if (importType.value === 'url' && !/^https?:\/\//i.test(importUrl.value.trim())) {
		importError.value = '请输入完整的 http/https 脚本链接。';
		return;
	}
	if (importType.value === 'file' && !importCode.value) {
		importError.value = '请选择 .user.js 文件。';
		return;
	}
	if (importType.value === 'catalog' && !selectedCatalog.value) {
		importError.value = '请先选择要导入的脚本。';
		return;
	}
	importing.value = true;
	try {
		const script = await api.scripts.import(
			importType.value === 'url'
				? { url: importUrl.value.trim() }
				: importType.value === 'file'
				? { code: importCode.value }
				: { url: selectedVersionUrl.value || selectedCatalog.value!.codeUrl, pinned: !!selectedVersionUrl.value }
		);
		await refreshScripts(true);
		applySelection(script.id);
		importOpen.value = false;
		importUrl.value = '';
		importCode.value = '';
		importFilename.value = '';
		toast('用户脚本已导入，关联实例后启动安装', 'ok');
	} catch (error) {
		importError.value = describeError(error);
	} finally {
		importing.value = false;
	}
}

async function checkUpdate(): Promise<void> {
	if (!editingId.value || dirty.value || checking.value) return;
	const scriptId = editingId.value;
	checking.value = true;
	formError.value = '';
	try {
		const result = await api.scripts.checkUpdate(scriptId);
		if (editingId.value !== scriptId || dirty.value) return;
		updateCheck.value = result;
		toast(updateCheck.value.available ? `发现新版本 ${updateCheck.value.latestVersion}` : '当前没有可用的新版本', 'ok');
	} catch (error) {
		formError.value = describeError(error);
	} finally {
		checking.value = false;
	}
}

async function applyUpdate(): Promise<void> {
	if (!editingId.value || dirty.value || updating.value) return;
	updating.value = true;
	try {
		const script = await api.scripts.applyUpdate(editingId.value);
		await refreshScripts(true);
		applySelection(script.id);
		updateOpen.value = false;
		toast('已更新源码，重启关联实例后安装新版本', 'ok');
	} catch (error) {
		formError.value = describeError(error);
		updateOpen.value = false;
	} finally {
		updating.value = false;
	}
}

async function downloadCode(): Promise<void> {
	if (!editingId.value || downloading.value) return;
	downloading.value = true;
	try {
		saveBlob(await api.scripts.code(editingId.value), `${current.value?.name || 'script'}.user.js`);
	} catch (error) {
		formError.value = describeError(error);
	} finally {
		downloading.value = false;
	}
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
	const matchesError = mode.value === 'plain' ? validateMatches(matches) : undefined;
	if (matchesError) {
		formError.value = matchesError;
		return;
	}
	if (!code.value.trim()) {
		formError.value = '请输入脚本代码。';
		return;
	}
	if (
		(mode.value === 'plain' && code.value.length > 250000) ||
		new TextEncoder().encode(code.value).byteLength > 2 * 1024 * 1024
	) {
		formError.value = mode.value === 'plain' ? '代码不能超过 250000 个字符。' : '用户脚本不能超过 2 MiB。';
		return;
	}
	saving.value = true;
	const creating = !editingId.value;
	try {
		const payload = {
			name: trimmed,
			code: code.value,
			matches: mode.value === 'plain' ? matches : undefined,
			enabled: enabled.value,
			mode: mode.value,
			pinned: mode.value === 'userscript' ? pinned.value : undefined,
			sourceUrl: sourceUrl.value,
			updateUrl: updateUrl.value
		};
		const saved: UserScript = editingId.value
			? await api.scripts.update(editingId.value, payload)
			: await api.scripts.create(payload);
		editingId.value = saved.id;
		name.value = saved.name;
		code.value = saved.code;
		matchesText.value = saved.matches.join('\n');
		enabled.value = saved.enabled;
		mode.value = saved.mode || 'plain';
		sourceUrl.value = saved.sourceUrl || '';
		updateUrl.value = saved.updateUrl || '';
		updateCheck.value = null;
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
		note="导入标准 .user.js 交由脚本管理器运行，或按 URL 注入普通 JavaScript；保存后重启关联实例生效。"
	>
		<template #actions>
			<BaseButton @click="startImport">导入 .user.js</BaseButton>
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
							{{
								script.mode === 'userscript'
									? `UserScript · ${script.version || '未标记版本'}`
									: `${script.matches.length} 条匹配`
							}}
							· {{ script.updatedAt.slice(0, 10) }}
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
				<label class="field">
					<span class="field__label">运行方式</span>
					<span class="field__control"
						><select
							v-model="mode"
							aria-label="脚本运行方式"
						>
							<option value="plain">普通 JavaScript</option>
							<option value="userscript">标准用户脚本（脚本管理器）</option>
						</select></span
					>
					<span class="field__hint">{{
						mode === 'userscript'
							? '保留完整元数据头，由脚本管理器处理 GM API、依赖和匹配规则。'
							: '在 DOMContentLoaded 注入；仅 * 为通配符，不提供 GM_* API。'
					}}</span>
				</label>
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

				<label
					v-if="mode === 'plain'"
					class="field"
				>
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

				<div
					v-if="mode === 'userscript'"
					class="source-panel"
				>
					<div class="source-summary">
						<span class="tag tag--dim">{{ current?.metadata?.values.name?.[0] || '名称将从元数据读取' }}</span
						><span class="mono small">v{{ current?.version || '—' }}</span>
					</div>
					<label class="field"
						><span class="field__label">源码来源 URL</span
						><span class="field__control"
							><input
								v-model="sourceUrl"
								type="url"
								placeholder="https://example.com/script.user.js" /></span
					></label>
					<label class="field"
						><span class="field__label">更新检查 URL</span
						><span class="field__control"
							><input
								v-model="updateUrl"
								type="url"
								placeholder="可留空，使用元数据或源码来源" /></span
					></label>
					<BaseSwitch
						v-model="pinned"
						label="固定来源版本"
						>固定来源版本</BaseSwitch
					>
					<div
						v-if="!isNew"
						class="source-actions"
					>
						<BaseButton
							type="button"
							size="sm"
							:busy="checking"
							:disabled="dirty || updating"
							@click="checkUpdate"
							>检查更新</BaseButton
						>
						<BaseButton
							type="button"
							size="sm"
							:disabled="dirty || checking || updating"
							@click="updateOpen = true"
							>从来源更新</BaseButton
						>
						<span
							v-if="updateCheck"
							class="small dim"
							>{{ updateCheck.available ? `可更新至 ${updateCheck.latestVersion}` : '当前无新版本' }}</span
						>
					</div>
					<p
						v-if="dirty"
						class="field__hint"
					>
						先保存修改，再检查或下载来源中的新版本。
					</p>
					<details v-if="current?.metadata">
						<summary>已保存的元数据</summary>
						<pre class="metadata-header">{{ current.metadata.raw }}</pre>
					</details>
				</div>

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
						v-if="!isNew"
						type="button"
						:busy="downloading"
						@click="downloadCode"
						>下载已保存 .user.js</BaseButton
					>
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

	<ModalPanel
		:open="importOpen"
		title="导入用户脚本"
		:close-on-mask="!importing"
		@close="!importing && (importOpen = false)"
	>
		<form
			class="import-form"
			@submit.prevent="importScript"
		>
			<label class="field"
				><span class="field__label">导入来源</span
				><span class="field__control"
					><select
						v-model="importType"
						aria-label="导入来源"
					>
						<option value="url">网络 URL</option>
						<option value="file">本地 .user.js 文件</option>
						<option value="catalog">官方 / GreasyFork / 脚本猫</option>
					</select></span
				></label
			>
			<label
				v-if="importType === 'url'"
				class="field"
				><span class="field__label">脚本 URL</span
				><span class="field__control"
					><input
						v-model="importUrl"
						type="url"
						required
						placeholder="https://example.com/script.user.js" /></span
				><span class="field__hint">服务端获取脚本源码并保留来源，用于后续更新。</span></label
			>
			<label
				v-else-if="importType === 'file'"
				class="field"
				><span class="field__label">选择文件</span
				><span class="field__control"
					><input
						type="file"
						accept=".js,.user.js,text/javascript,application/javascript"
						@change="chooseFile" /></span
				><span
					v-if="importFilename"
					class="field__hint"
					>{{ importFilename }}</span
				></label
			>
			<div
				v-if="importType === 'catalog'"
				class="catalog"
			>
				<label class="field"
					><span class="field__label">脚本来源</span
					><span class="field__control"
						><select
							v-model="catalogProvider"
							aria-label="脚本来源"
						>
							<option value="official">OCS 官方脚本</option>
							<option value="greasyfork">GreasyFork</option>
							<option value="scriptcat">脚本猫</option>
						</select></span
					></label
				>
				<div class="catalog-search">
					<label class="field"
						><span class="field__label">搜索脚本</span
						><span class="field__control"
							><input
								v-model="catalogQuery"
								maxlength="200"
								placeholder="输入脚本名称或关键词"
								@keydown.enter.prevent="loadCatalog()" /></span></label
					><BaseButton
						type="button"
						:busy="catalogLoading"
						@click="loadCatalog()"
						>搜索</BaseButton
					>
				</div>
				<div
					class="catalog-list"
					aria-label="搜索结果"
				>
					<p
						v-if="catalogLoading"
						class="field__hint"
					>
						正在获取脚本列表…
					</p>
					<p
						v-else-if="!catalogItems.length"
						class="field__hint"
					>
						暂无匹配的脚本。
					</p>
					<button
						v-for="script in catalogItems"
						:key="script.id"
						type="button"
						class="catalog-item"
						:class="{ 'is-selected': selectedCatalog?.id === script.id }"
						:disabled="catalogLoading"
						@click="selectCatalog(script)"
					>
						<span
							>{{ script.name }}
							<span
								v-if="script.version"
								class="mono dim small"
								>v{{ script.version }}</span
							></span
						><span class="small dim">{{ script.description }}</span>
					</button>
				</div>
				<div class="source-actions">
					<BaseButton
						type="button"
						size="sm"
						:disabled="catalogPage <= 1 || catalogLoading"
						@click="loadCatalog(catalogPage - 1)"
						>上一页</BaseButton
					><span class="small dim">第 {{ catalogPage }} 页</span
					><BaseButton
						type="button"
						size="sm"
						:disabled="!catalogItems.length || catalogLoading"
						@click="loadCatalog(catalogPage + 1)"
						>下一页</BaseButton
					>
				</div>
				<div
					v-if="selectedCatalog"
					class="source-panel"
				>
					<span class="small">已选择：{{ selectedCatalog.name }}</span>
					<p
						v-if="versionsLoading"
						class="field__hint"
					>
						正在获取版本列表…
					</p>
					<label
						v-if="catalogVersions.length"
						class="field"
						><span class="field__label">安装版本</span
						><span class="field__control"
							><select
								v-model="selectedVersionUrl"
								aria-label="安装版本"
							>
								<option value="">最新版本（更新时跟随来源）</option>
								<option
									v-for="item in catalogVersions"
									:key="item.codeUrl"
									:value="item.codeUrl"
								>
									{{ item.version }}
								</option>
							</select></span
						><span class="field__hint">选择具体版本后保留对应下载 URL；后续更新仍使用该版本来源。</span></label
					><a
						v-if="selectedCatalog.homepage"
						:href="selectedCatalog.homepage"
						target="_blank"
						rel="noopener noreferrer"
						class="small"
						>打开脚本主页 ↗</a
					>
				</div>
				<p
					v-if="catalogError"
					class="inline-error"
				>
					{{ catalogError }}
				</p>
			</div>
			<p class="field__hint">需要包含 ==UserScript== 元数据头，最大 2 MiB；文件内容经浏览器读取上传。</p>
			<p
				v-if="importError"
				class="inline-error"
			>
				{{ importError }}
			</p>
			<BaseButton
				type="submit"
				variant="primary"
				:busy="importing"
				:disabled="importType === 'catalog' && (catalogLoading || versionsLoading)"
				>导入脚本</BaseButton
			>
		</form>
	</ModalPanel>

	<ConfirmDialog
		:open="updateOpen"
		title="更新脚本源码"
		:message="`从已配置来源重新下载「${current?.name || name}」吗？`"
		note="这会替换已保存的脚本代码。重启关联实例后安装更新。"
		confirm-text="下载并更新"
		:busy="updating"
		@cancel="updateOpen = false"
		@confirm="applyUpdate"
	/>

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

.source-panel,
.import-form,
.catalog {
	display: flex;
	flex-direction: column;
	gap: 14px;
}

.catalog-search {
	display: flex;
	align-items: flex-end;
	gap: 10px;
}

.catalog-search .field {
	flex: 1;
}

.catalog-list {
	max-height: 240px;
	overflow: auto;
	border: 1px solid var(--line-1);
	border-radius: var(--radius);
}

.catalog-list > p {
	padding: 12px;
}

.catalog-item {
	display: flex;
	flex-direction: column;
	gap: 5px;
	width: 100%;
	padding: 12px;
	border: 0;
	border-bottom: 1px solid var(--line-1);
	background: transparent;
	text-align: left;
	font-size: 12px;
	color: var(--text-1);
}

.catalog-item.is-selected {
	background: var(--accent-soft);
}

.source-panel {
	padding: 14px;
	border: 1px solid var(--line-1);
	border-radius: var(--radius);
}

.source-summary,
.source-actions {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 10px;
}

.source-panel summary {
	cursor: pointer;
	font-size: 11px;
	color: var(--text-3);
}

.metadata-header {
	max-height: 220px;
	overflow: auto;
	margin: 12px 0 0;
	font-size: 11px;
	line-height: 1.6;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	color: var(--text-2);
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
