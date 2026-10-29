<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import { saveBlob } from '@/api/client';
import { downloadLabel, formatBytes, profileOf } from '@/lib/format';
import { feed } from '@/stores/events';
import { toast } from '@/stores/toasts';
import type { BrowserView, DownloadItem } from '@/api/types';

const props = defineProps<{ browser: BrowserView }>();
const emit = defineEmits<{ count: [count: number] }>();

const items = ref<DownloadItem[]>([]);
const loading = ref(false);
const error = ref('');
const downloading = ref('');
const progress = ref(-1);
let controller: AbortController | undefined;

const lastDownloadEvent = computed(() => {
	for (let index = feed.items.length - 1; index >= 0; index -= 1) {
		const event = feed.items[index];
		if (event.type === 'download-completed' && profileOf(event) === props.browser.id) return event.id;
	}
	return 0;
});

async function load(): Promise<void> {
	loading.value = true;
	error.value = '';
	try {
		items.value = await api.browsers.downloads(props.browser.id);
	} catch (caught) {
		error.value = describeError(caught);
	} finally {
		loading.value = false;
	}
}

async function download(item: DownloadItem): Promise<void> {
	if (downloading.value) return;
	controller = new AbortController();
	downloading.value = item.filename;
	progress.value = -1;
	try {
		const blob = await api.browsers.download(props.browser.id, item.filename, {
			signal: controller.signal,
			onProgress: (ratio) => {
				progress.value = ratio;
			}
		});
		saveBlob(blob, downloadLabel(item.filename));
		toast('文件已开始下载', 'ok');
	} catch (caught) {
		if ((caught as DOMException | undefined)?.name === 'AbortError') toast('已取消下载', 'info');
		else toast(describeError(caught), 'error');
	} finally {
		downloading.value = '';
		progress.value = -1;
		controller = undefined;
	}
}

function cancel(): void {
	controller?.abort();
}

watch(items, (list) => emit('count', list.length), { immediate: true });

watch(lastDownloadEvent, () => void load());

onMounted(load);

onBeforeUnmount(() => controller?.abort());
</script>

<template>
	<section class="panel">
		<header class="panel__head">
			<span class="panel__title">Downloads</span>
			<div class="downloads-tools">
				<span class="dim small">{{ items.length }} 个文件</span>
				<button
					type="button"
					class="icon-btn"
					title="刷新下载列表"
					:disabled="loading"
					@click="load"
				>
					<AppIcon
						name="refresh"
						:size="14"
					/>
				</button>
			</div>
		</header>

		<p
			v-if="error"
			class="inline-error downloads-error"
		>
			{{ error }}
		</p>

		<div
			v-if="!items.length && !loading"
			class="empty"
		>
			暂无下载文件。
		</div>

		<div
			v-else
			class="downloads"
		>
			<div
				v-for="item in items"
				:key="item.filename"
				class="download-row"
			>
				<div class="download-main">
					<span class="download-name truncate">{{ downloadLabel(item.filename) }}</span>
					<span class="download-meta mono">
						{{ formatBytes(item.size) }}
						<span v-if="downloading === item.filename"> · 下载中</span>
					</span>
				</div>
				<div class="download-actions">
					<BaseButton
						v-if="downloading === item.filename"
						size="sm"
						variant="ghost"
						@click="cancel"
						>取消</BaseButton
					>
					<BaseButton
						v-else
						size="sm"
						:disabled="!!downloading"
						title="下载文件"
						@click="download(item)"
					>
						<AppIcon
							name="download"
							:size="13"
						/>
						下载
					</BaseButton>
				</div>
				<div
					v-if="downloading === item.filename"
					class="download-progress"
				>
					<span
						:class="{ 'is-indeterminate': progress < 0 }"
						:style="progress >= 0 ? { width: `${progress * 100}%` } : undefined"
					></span>
				</div>
			</div>
		</div>

		<footer class="panel__foot">
			<span>文件保存在服务端数据目录，下载需要认证。</span>
			<span class="mono">{{ browser.runtime.status }}</span>
		</footer>
	</section>
</template>

<style scoped>
.downloads-tools {
	display: flex;
	align-items: center;
	gap: 8px;
}

.downloads-error {
	margin: 12px 18px;
}

.downloads {
	display: flex;
	flex-direction: column;
}

.download-row {
	position: relative;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	padding: 12px 18px;
	border-top: 1px solid var(--line-1);
}

.download-row:first-child {
	border-top: 0;
}

.download-main {
	display: flex;
	flex-direction: column;
	gap: 3px;
	min-width: 0;
}

.download-name {
	font-size: 12px;
	color: var(--text-1);
}

.download-meta {
	font-size: 9.5px;
	color: var(--text-3);
}

.download-actions {
	flex: none;
}

.download-progress {
	position: absolute;
	left: 18px;
	right: 18px;
	bottom: 4px;
	height: 1px;
	background: var(--line-1);
	overflow: hidden;
}

.download-progress span {
	display: block;
	height: 1px;
	background: var(--accent);
	transition: width 0.2s linear;
}

.download-progress span.is-indeterminate {
	width: 32%;
	animation: download-slide 1.2s var(--ease) infinite;
}

@keyframes download-slide {
	0% {
		transform: translateX(-110%);
	}
	100% {
		transform: translateX(340%);
	}
}
</style>
