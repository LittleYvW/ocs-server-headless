<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import BaseButton from './BaseButton.vue';
import { apiBase, currentBearer } from '@/api/client';

const props = defineProps<{ browserId: string; pageId: string }>();
const active = ref(false);
const image = ref('');
const error = ref('');
let controller: AbortController | undefined;

function stop(): void {
	active.value = false;
	controller?.abort();
	controller = undefined;
	if (image.value) URL.revokeObjectURL(image.value);
	image.value = '';
}

async function start(): Promise<void> {
	stop();
	active.value = true;
	error.value = '';
	const local = new AbortController();
	controller = local;
	try {
		const response = await fetch(
			`${apiBase()}/api/v1/browsers/${encodeURIComponent(props.browserId)}/preview?pageId=${encodeURIComponent(
				props.pageId
			)}`,
			{
				headers: { Authorization: `Bearer ${currentBearer()}` },
				signal: local.signal
			}
		);
		if (!response.ok || !response.body) throw new Error(`实时预览连接失败（${response.status}）`);
		const reader = response.body.getReader();
		let buffer = new Uint8Array(0);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const next = new Uint8Array(buffer.length + value.length);
				next.set(buffer);
				next.set(value, buffer.length);
				buffer = next;
				if (buffer.length > 4 * 1024 * 1024) throw new Error('实时预览帧超出大小限制');
				for (;;) {
					let end = -1;
					for (let i = 0; i + 3 < buffer.length; i++) {
						if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) {
							end = i + 4;
							break;
						}
					}
					if (end < 0) break;
					const length = Number(new TextDecoder().decode(buffer.slice(0, end)).match(/Content-Length:\s*(\d+)/i)?.[1]);
					if (!length || length > 2 * 1024 * 1024) throw new Error('实时预览帧格式无效');
					if (buffer.length < end + length + 2) break;
					const frame = buffer.slice(end, end + length);
					buffer = buffer.slice(end + length + 2);
					if (local.signal.aborted) return;
					const previous = image.value;
					image.value = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
					if (previous) URL.revokeObjectURL(previous);
				}
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
	} catch (caught) {
		if (!local.signal.aborted) error.value = (caught as Error).message;
	} finally {
		if (controller === local) {
			active.value = false;
			controller = undefined;
		}
	}
}

watch(() => [props.browserId, props.pageId], stop);
onBeforeUnmount(stop);
</script>

<template>
	<section class="panel live-preview">
		<header class="panel__head">
			<span class="panel__title">实时预览</span>
			<BaseButton
				size="sm"
				:disabled="!pageId"
				@click="active ? stop() : start()"
				>{{ active ? '停止预览' : '开始预览' }}</BaseButton
			>
		</header>
		<img
			v-if="image"
			:src="image"
			alt="浏览器实时画面"
		/>
		<p
			v-else-if="active"
			class="empty"
		>
			等待画面…
		</p>
		<p
			v-if="error"
			class="inline-error"
		>
			{{ error }}
		</p>
	</section>
</template>

<style scoped>
.live-preview {
	margin-top: 18px;
}
.live-preview img {
	display: block;
	width: 100%;
	object-fit: contain;
	max-height: 720px;
}
</style>
