<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import { normalizeUrl } from '@/lib/config';
import { formatStamp, profileOf } from '@/lib/format';
import { feed } from '@/stores/events';
import { toast } from '@/stores/toasts';
import type { BrowserView, PageInfo } from '@/api/types';

const props = defineProps<{ browser: BrowserView }>();
const emit = defineEmits<{ count: [count: number]; start: [] }>();

const pages = ref<PageInfo[]>([]);
const selectedId = ref('');
const loadingPages = ref(false);
const pagesError = ref('');

const shotUrl = ref('');
const shotAt = ref('');
const shotBusy = ref(false);
const shotError = ref('');
const autoRefresh = ref(true);

const navUrl = ref('');
const clickSelector = ref('');
const fillSelector = ref('');
const fillText = ref('');
const action = ref<'' | 'navigate' | 'click' | 'fill'>('');
const actionError = ref('');

let timer: ReturnType<typeof setInterval> | undefined;
let pageTimer: ReturnType<typeof setTimeout> | undefined;
let controller: AbortController | undefined;
let requestSeq = 0;

const running = () => props.browser.runtime.status === 'running';

const lastPageEvent = computed(() => {
	for (let index = feed.items.length - 1; index >= 0; index -= 1) {
		const event = feed.items[index];
		if ((event.type === 'page-created' || event.type === 'page-closed') && profileOf(event) === props.browser.id) {
			return event.id;
		}
	}
	return 0;
});

function revokeShot(): void {
	if (shotUrl.value) URL.revokeObjectURL(shotUrl.value);
	shotUrl.value = '';
}

function resetView(): void {
	requestSeq += 1;
	controller?.abort();
	controller = undefined;
	shotBusy.value = false;
	shotError.value = '';
	shotAt.value = '';
	selectedId.value = '';
	pages.value = [];
	revokeShot();
}

async function loadPages(preferred?: string): Promise<void> {
	if (!running()) return;
	loadingPages.value = true;
	pagesError.value = '';
	try {
		const list = await api.browsers.pages(props.browser.id);
		pages.value = list;
		const previous = selectedId.value;
		const wanted =
			preferred || (list.some((page) => page.id === selectedId.value) ? selectedId.value : list[0]?.id || '');
		selectedId.value = wanted;
		const current = list.find((page) => page.id === wanted);
		// Background refreshes must not overwrite a URL the user is typing.
		if (current && (wanted !== previous || !navUrl.value)) navUrl.value = current.url;
	} catch (error) {
		pagesError.value = describeError(error);
	} finally {
		loadingPages.value = false;
	}
}

async function capture(): Promise<void> {
	if (!running()) return;
	const seq = ++requestSeq;
	controller?.abort();
	const local = new AbortController();
	controller = local;
	shotBusy.value = true;
	shotError.value = '';
	try {
		const blob = await api.browsers.screenshot(props.browser.id, selectedId.value || undefined, {
			signal: local.signal
		});
		if (seq !== requestSeq) return;
		revokeShot();
		shotUrl.value = URL.createObjectURL(blob);
		shotAt.value = new Date().toISOString();
	} catch (error) {
		if (seq !== requestSeq) return;
		if ((error as DOMException | undefined)?.name === 'AbortError') return;
		shotError.value = describeError(error);
	} finally {
		if (seq === requestSeq) {
			shotBusy.value = false;
			controller = undefined;
		}
	}
}

async function refreshPages(): Promise<void> {
	await loadPages(selectedId.value);
	await capture();
}

async function reloadAll(): Promise<void> {
	await refreshPages();
}

function ensureTimer(): void {
	if (timer) clearInterval(timer);
	timer = undefined;
	if (!autoRefresh.value || !running()) return;
	timer = setInterval(() => {
		if (!document.hidden && running()) void capture();
	}, 6000);
}

function selectPage(id: string): void {
	if (id === selectedId.value) return;
	selectedId.value = id;
	const page = pages.value.find((item) => item.id === id);
	if (page) navUrl.value = page.url;
	void capture();
}

async function navigate(): Promise<void> {
	if (action.value || !running()) return;
	const url = normalizeUrl(navUrl.value);
	if (!url) {
		actionError.value = '请输入导航地址。';
		return;
	}
	action.value = 'navigate';
	actionError.value = '';
	try {
		const page = await api.browsers.navigate(props.browser.id, url, selectedId.value || undefined);
		selectedId.value = page.id;
		navUrl.value = page.url;
		await loadPages(page.id);
		await capture();
	} catch (error) {
		actionError.value = describeError(error);
	} finally {
		action.value = '';
	}
}

async function click(): Promise<void> {
	if (action.value || !running()) return;
	const selector = clickSelector.value.trim();
	if (!selector) {
		actionError.value = '请输入选择器。';
		return;
	}
	action.value = 'click';
	actionError.value = '';
	try {
		await api.browsers.click(props.browser.id, selector, selectedId.value || undefined);
		await new Promise((resolve) => setTimeout(resolve, 350));
		await loadPages(selectedId.value);
		await capture();
	} catch (error) {
		actionError.value = describeError(error);
	} finally {
		action.value = '';
	}
}

async function fill(): Promise<void> {
	if (action.value || !running()) return;
	const selector = fillSelector.value.trim();
	if (!selector) {
		actionError.value = '请输入选择器。';
		return;
	}
	action.value = 'fill';
	actionError.value = '';
	try {
		await api.browsers.fill(props.browser.id, selector, fillText.value, selectedId.value || undefined);
		fillText.value = '';
		await capture();
		toast('已填入字段。', 'ok');
	} catch (error) {
		actionError.value = describeError(error);
	} finally {
		action.value = '';
	}
}

function onVisibility(): void {
	if (!document.hidden && running()) void capture();
}

watch(pages, (list) => emit('count', list.length), { immediate: true });

// Automation and navigation can open or close pages without a user action.
watch(lastPageEvent, () => {
	if (!running()) return;
	clearTimeout(pageTimer);
	pageTimer = setTimeout(() => void refreshPages(), 250);
});

watch(autoRefresh, ensureTimer);

watch(
	() => props.browser.runtime.status,
	(status) => {
		if (status === 'running') {
			void reloadAll();
			ensureTimer();
		} else {
			resetView();
			ensureTimer();
		}
	}
);

onMounted(() => {
	if (running()) void reloadAll();
	ensureTimer();
	document.addEventListener('visibilitychange', onVisibility);
});

onBeforeUnmount(() => {
	requestSeq += 1;
	controller?.abort();
	if (timer) clearInterval(timer);
	clearTimeout(pageTimer);
	document.removeEventListener('visibilitychange', onVisibility);
	revokeShot();
});
</script>

<template>
	<div
		v-if="!running()"
		class="pages-layout"
	>
		<section class="panel pages-panel">
			<header class="panel__head">
				<span class="panel__title">Pages</span>
				<span class="tag tag--dim">offline</span>
			</header>
			<div
				class="ghost-pages"
				aria-hidden="true"
			>
				<div
					v-for="index in 3"
					:key="index"
					class="ghost-page"
				>
					<span class="ghost-page__dot"></span>
					<span class="ghost-page__line"></span>
				</div>
			</div>
			<footer class="panel__foot">
				<span>{{ pages.length }} 个页面</span>
				<span class="mono">—</span>
			</footer>
		</section>

		<section class="panel shot-panel">
			<header class="panel__head">
				<span class="panel__title">Screen</span>
				<span class="tag tag--dim">idle</span>
			</header>
			<div class="offline-shot">
				<svg
					class="offline-glyph"
					viewBox="0 0 120 80"
					fill="none"
					stroke="currentColor"
					aria-hidden="true"
				>
					<rect
						x="5"
						y="9"
						width="110"
						height="62"
					/>
					<line
						x1="5"
						y1="21"
						x2="115"
						y2="21"
					/>
					<circle
						cx="12"
						cy="15"
						r="1.1"
					/>
					<circle
						cx="17"
						cy="15"
						r="1.1"
					/>
					<path d="M17 42c14-11 27-11 41 0s27 11 43 0" />
				</svg>
				<p class="offline-title">实例未运行</p>
				<BaseButton
					variant="primary"
					@click="emit('start')"
				>
					<AppIcon
						name="play"
						:size="13"
					/>
					启动实例
				</BaseButton>
				<p class="offline-note mono">page ids expire per browser run</p>
			</div>
			<footer class="panel__foot">
				<span>—</span>
				<span>启动后可查看页面与截图</span>
			</footer>
		</section>
	</div>

	<div
		v-else
		class="pages-layout"
	>
		<section class="panel pages-panel">
			<header class="panel__head">
				<span class="panel__title">Pages</span>
				<button
					type="button"
					class="icon-btn"
					title="刷新页面列表"
					:disabled="loadingPages"
					@click="refreshPages"
				>
					<AppIcon
						name="refresh"
						:size="14"
					/>
				</button>
			</header>
			<div
				v-if="loadingPages && !pages.length"
				class="empty"
			>
				读取页面列表…
			</div>
			<div
				v-else-if="!pages.length"
				class="empty"
			>
				没有可用页面。
			</div>
			<div
				v-else
				class="page-list"
			>
				<button
					v-for="page in pages"
					:key="page.id"
					type="button"
					class="page-item"
					:class="{ 'is-active': page.id === selectedId }"
					@click="selectPage(page.id)"
				>
					<span class="page-item__title truncate">{{ page.title || '未命名页面' }}</span>
					<span class="page-item__url mono truncate">{{ page.url }}</span>
				</button>
			</div>
			<p
				v-if="pagesError"
				class="pages-error inline-error"
			>
				{{ pagesError }}
			</p>
			<footer class="panel__foot">
				<span>{{ pages.length }} 个页面</span>
				<span class="mono">{{ selectedId ? selectedId.slice(0, 8) : '—' }}</span>
			</footer>
		</section>

		<section class="panel shot-panel">
			<header class="panel__head">
				<span class="panel__title">Screen</span>
				<div class="shot-tools">
					<BaseSwitch
						v-model="autoRefresh"
						label="自动刷新截图"
						>自动</BaseSwitch
					>
					<span class="dim small mono">6s</span>
					<button
						type="button"
						class="icon-btn"
						title="立即刷新截图"
						:disabled="shotBusy"
						@click="capture"
					>
						<AppIcon
							name="refresh"
							:size="14"
						/>
					</button>
				</div>
			</header>

			<div class="shot">
				<div
					v-if="shotBusy"
					class="shot__progress"
					aria-hidden="true"
				>
					<span></span>
				</div>
				<img
					v-if="shotUrl"
					:src="shotUrl"
					alt="当前页面截图"
				/>
				<div
					v-else
					class="shot__placeholder"
				>
					{{ shotError ? '截图读取失败' : '等待截图…' }}
				</div>
			</div>

			<div
				v-if="shotError"
				class="shot__error inline-error"
			>
				{{ shotError }}
			</div>

			<footer class="panel__foot">
				<span class="mono">{{ shotAt ? `SHOT ${formatStamp(shotAt)}` : '—' }}</span>
				<span>{{ autoRefresh ? '自动刷新开启' : '自动刷新暂停' }}</span>
			</footer>
		</section>
	</div>

	<section
		v-if="running()"
		class="panel ops-panel"
	>
		<header class="panel__head">
			<span class="panel__title">Restricted Actions</span>
			<span class="dim small">仅导航、点击、填写，无 JS / CDP 入口</span>
		</header>
		<div class="ops">
			<form
				class="ops__row"
				@submit.prevent="navigate"
			>
				<label class="field field--grow">
					<span class="field__label">导航地址</span>
					<span class="field__control">
						<input
							v-model="navUrl"
							maxlength="4096"
							spellcheck="false"
							placeholder="https://example.com"
						/>
					</span>
				</label>
				<BaseButton
					type="submit"
					:busy="action === 'navigate'"
					:disabled="!!action"
					>前往</BaseButton
				>
			</form>

			<div class="ops__grid">
				<form
					class="ops__row"
					@submit.prevent="click"
				>
					<label class="field field--grow">
						<span class="field__label">点击选择器</span>
						<span class="field__control">
							<input
								v-model="clickSelector"
								maxlength="2000"
								spellcheck="false"
								placeholder="button[type=submit]"
							/>
						</span>
					</label>
					<BaseButton
						type="submit"
						:busy="action === 'click'"
						:disabled="!!action"
						>点击</BaseButton
					>
				</form>

				<form
					class="ops__row"
					@submit.prevent="fill"
				>
					<label class="field field--grow">
						<span class="field__label">填写字段</span>
						<span class="field__control">
							<input
								v-model="fillSelector"
								maxlength="2000"
								spellcheck="false"
								placeholder="input[name=username]"
							/>
						</span>
					</label>
					<label class="field field--grow">
						<span class="field__label">内容</span>
						<span class="field__control">
							<input
								v-model="fillText"
								maxlength="100000"
								spellcheck="false"
								placeholder="临时输入值"
							/>
						</span>
					</label>
					<BaseButton
						type="submit"
						:busy="action === 'fill'"
						:disabled="!!action"
						>填充</BaseButton
					>
				</form>
			</div>

			<p
				v-if="actionError"
				class="inline-error"
			>
				{{ actionError }}
			</p>
			<p class="ops__note">填充内容仅提交到当前页面，不会写入事件记录或客户端日志。</p>
		</div>
	</section>
</template>

<style scoped>
.pages-layout {
	display: grid;
	grid-template-columns: 264px minmax(0, 1fr);
	gap: 18px;
	align-items: stretch;
}

.ghost-pages {
	display: flex;
	flex-direction: column;
	padding: 8px 0;
}

.ghost-page {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 13px 18px;
	border-top: 1px solid var(--line-1);
}

.ghost-page:first-child {
	border-top: 0;
}

.ghost-page__dot {
	width: 4px;
	height: 4px;
	flex: none;
	border-radius: 50%;
	border: 1px solid var(--line-3);
}

.ghost-page__line {
	height: 1px;
	width: 66%;
	background: var(--line-2);
}

.ghost-page:nth-child(2) .ghost-page__line {
	width: 48%;
}

.ghost-page:nth-child(3) .ghost-page__line {
	width: 58%;
}

.offline-shot {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 16px;
	min-height: 360px;
	padding: 32px;
	background: rgba(0, 0, 0, 0.2);
}

.offline-glyph {
	width: 132px;
	height: 88px;
	color: var(--text-3);
	opacity: 0.55;
	stroke-width: 1;
}

.offline-title {
	font-size: 13px;
	color: var(--text-2);
}

.offline-note {
	font-size: 9px;
	letter-spacing: 0.14em;
	text-transform: uppercase;
	color: var(--text-3);
}

.pages-panel {
	display: flex;
	flex-direction: column;
	min-height: 380px;
}

.page-list {
	display: flex;
	flex-direction: column;
	flex: 1;
	overflow-y: auto;
	max-height: 420px;
}

.page-item {
	position: relative;
	display: flex;
	flex-direction: column;
	gap: 3px;
	padding: 11px 16px;
	border: 0;
	border-top: 1px solid var(--line-1);
	background: transparent;
	text-align: left;
	transition: background 0.14s;
}

.page-item:first-child {
	border-top: 0;
}

.page-item::before {
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

.page-item:hover {
	background: rgba(255, 255, 255, 0.02);
}

.page-item.is-active {
	background: rgba(255, 255, 255, 0.025);
}

.page-item.is-active::before {
	height: 26px;
}

.page-item__title {
	font-size: 12px;
	color: var(--text-2);
}

.page-item.is-active .page-item__title {
	color: var(--text-1);
}

.page-item__url {
	font-size: 9.5px;
	color: var(--text-3);
	width: 100%;
}

.pages-error {
	margin: 10px 16px;
}

.shot-panel {
	display: flex;
	flex-direction: column;
	min-width: 0;
}

.shot-tools {
	display: flex;
	align-items: center;
	gap: 12px;
}

.shot {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: center;
	min-height: 384px;
	padding: 12px;
	overflow: hidden;
	background: rgba(0, 0, 0, 0.34);
}

.shot img {
	display: block;
	width: 100%;
	height: 360px;
	border: 1px solid var(--line-1);
	object-fit: contain;
	object-position: top center;
}

.shot__placeholder {
	font-size: 11px;
	letter-spacing: 0.08em;
	color: var(--text-3);
}

.shot__progress {
	position: absolute;
	top: 0;
	left: 0;
	right: 0;
	height: 1px;
	background: var(--line-1);
	overflow: hidden;
	z-index: 2;
}

.shot__progress span {
	position: absolute;
	top: 0;
	left: 0;
	width: 28%;
	height: 1px;
	background: var(--accent);
	animation: shot-slide 1.1s var(--ease) infinite;
}

.shot__error {
	margin: 10px 14px;
}

@keyframes shot-slide {
	0% {
		transform: translateX(-100%);
	}
	100% {
		transform: translateX(420%);
	}
}

.ops-panel {
	margin-top: 18px;
}

.ops {
	display: flex;
	flex-direction: column;
	gap: 14px;
	padding: 16px 18px 14px;
}

.ops__grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 14px;
}

.ops__row {
	display: flex;
	align-items: flex-end;
	gap: 10px;
	min-width: 0;
}

.field--grow {
	flex: 1;
}

.ops__note {
	font-size: 10.5px;
	color: var(--text-3);
}

@media (max-width: 1080px) {
	.pages-layout {
		grid-template-columns: minmax(0, 1fr);
	}

	.pages-panel {
		min-height: 0;
	}

	.page-list {
		max-height: 200px;
	}

	.ops__grid {
		grid-template-columns: minmax(0, 1fr);
	}
}

@media (max-width: 620px) {
	.shot {
		min-height: 264px;
		padding: 8px;
	}

	.shot img {
		height: 240px;
	}

	.ops__row {
		flex-direction: column;
		align-items: stretch;
	}
}
</style>
