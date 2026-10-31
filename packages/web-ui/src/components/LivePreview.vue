<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import BaseButton from './BaseButton.vue';
import { apiBase, currentBearer } from '@/api/client';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import type { BrowserControlSession, BrowserInputEvent, InputModifier } from '@/api/types';
import { InputChannel } from '@/lib/browser-input';

const props = defineProps<{ browserId: string; pageId: string }>();
const emit = defineEmits<{ active: [active: boolean]; changed: [] }>();
const active = ref(false);
const image = ref('');
const error = ref('');
const controlError = ref('');
const controlled = ref(false);
const controlBusy = ref(false);
const panel = ref<HTMLElement>();
const keyboard = ref<HTMLTextAreaElement>();
const draft = ref('');
const viewport = ref<{ width: number; height: number }>();
let controller: AbortController | undefined;
let session: BrowserControlSession | undefined;
let sessionBrowserId = '';
let channel: InputChannel | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let controlGeneration = 0;
let controlTransition: Promise<void> = Promise.resolve();

function stopControl(): void {
	controlGeneration++;
	controlBusy.value = false;
	controlled.value = false;
	channel?.stop();
	channel = undefined;
	clearInterval(heartbeat);
	clearTimeout(compositionTimer);
	composing = false;
	draft.value = '';
	if (keyboard.value) keyboard.value.value = '';
	const previous = session;
	const previousBrowserId = sessionBrowserId;
	session = undefined;
	if (previous) {
		controlTransition = controlTransition
			.then(async () => {
				await api.browsers.stopControl(previousBrowserId, previous);
			})
			.catch(() => {});
	}
}

async function startControl(): Promise<void> {
	if (controlBusy.value || !active.value || !image.value || !viewport.value) return;
	stopControl();
	const generation = controlGeneration;
	const browserId = props.browserId;
	const pageId = props.pageId;
	controlBusy.value = true;
	controlError.value = '';
	const previousTransition = controlTransition;
	let finishTransition!: () => void;
	controlTransition = new Promise((resolve) => {
		finishTransition = resolve;
	});
	try {
		await previousTransition;
		if (generation !== controlGeneration || browserId !== props.browserId || pageId !== props.pageId || !active.value)
			return;
		const acquired = await api.browsers.startControl(browserId, pageId);
		if (generation !== controlGeneration || browserId !== props.browserId || pageId !== props.pageId || !active.value) {
			await api.browsers.stopControl(browserId, acquired).catch(() => {});
			return;
		}
		if (viewport.value?.width !== acquired.viewport.width || viewport.value?.height !== acquired.viewport.height) {
			await api.browsers.stopControl(browserId, acquired).catch(() => {});
			throw new Error('画面尺寸已变化，等待新画面后重试。');
		}
		session = acquired;
		sessionBrowserId = browserId;
		channel = new InputChannel(
			async (sequence, events) => {
				const result = await api.browsers.input(browserId, acquired, sequence, events);
				if (session === acquired && events.some((event) => event.type === 'click' || event.type === 'key'))
					emit('changed');
				return result;
			},
			(caught) => {
				if (session !== acquired) return;
				controlError.value = describeError(caught);
				stopControl();
			}
		);
		heartbeat = setInterval(() => channel?.heartbeat(), Math.min(5000, acquired.leaseMs / 3));
		controlled.value = true;
		await nextTick();
		keyboard.value?.focus({ preventScroll: true });
	} catch (caught) {
		if (generation === controlGeneration) controlError.value = describeError(caught);
	} finally {
		finishTransition();
		if (generation === controlGeneration) controlBusy.value = false;
	}
}

function enqueue(event: BrowserInputEvent): void {
	if (controlled.value) channel?.push(event);
}

function modifiers(event: MouseEvent | KeyboardEvent): InputModifier[] {
	const keys: InputModifier[] = [];
	if (event.altKey) keys.push('Alt');
	if (event.ctrlKey) keys.push('Control');
	if (event.metaKey && !event.ctrlKey) keys.push('ControlOrMeta');
	if (event.shiftKey) keys.push('Shift');
	return keys;
}

function point(event: MouseEvent): { x: number; y: number } | undefined {
	if (!controlled.value || !session || !(event.currentTarget instanceof HTMLImageElement)) return;
	if (viewport.value?.width !== session.viewport.width || viewport.value?.height !== session.viewport.height) {
		controlError.value = '远端画面尺寸已变化，请重新开启直接操作。';
		stopControl();
		return;
	}
	// The image has its natural aspect ratio, without object-fit letterboxing.
	const bounds = event.currentTarget.getBoundingClientRect();
	const x = (event.clientX - bounds.left) / bounds.width;
	const y = (event.clientY - bounds.top) / bounds.height;
	if (bounds.width && bounds.height && x >= 0 && y >= 0 && x < 1 && y < 1) return { x, y };
}

function click(event: MouseEvent, button: 'left' | 'right' = 'left'): void {
	const position = point(event);
	if (!position) return;
	event.preventDefault();
	keyboard.value?.focus({ preventScroll: true });
	enqueue({ type: 'click', ...position, button, modifiers: modifiers(event) });
}

function wheel(event: WheelEvent): void {
	const position = point(event);
	if (!position || !session) return;
	event.preventDefault();
	const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? session.viewport.height : 1;
	const delta = (value: number) => Math.max(-10000, Math.min(10000, value * scale));
	enqueue({ type: 'wheel', ...position, deltaX: delta(event.deltaX), deltaY: delta(event.deltaY) });
}

function sendText(value: string): void {
	if (!value) return;
	if (value.length > 10000) {
		controlError.value = '每次最多输入 10000 个字符。';
		return;
	}
	enqueue({ type: 'text', text: value });
}

function flushText(): void {
	if (composing || !keyboard.value) return;
	const value = keyboard.value.value;
	keyboard.value.value = '';
	sendText(value);
}

function compositionEnd(): void {
	composing = false;
	// Some browsers emit the final input after compositionend, others before it.
	// Both paths drain the same textarea so committed text is submitted once.
	clearTimeout(compositionTimer);
	compositionTimer = setTimeout(flushText, 0);
}

function keydown(event: KeyboardEvent): void {
	if (!controlled.value || event.isComposing || composing || event.key === 'Process' || event.key === 'Dead') return;
	if (event.ctrlKey && event.altKey && event.key === 'Escape') {
		event.preventDefault();
		stopControl();
		return;
	}
	if (['Control', 'Alt', 'Meta', 'Shift', 'CapsLock'].includes(event.key)) return;
	if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV') return; // paste reads local clipboard text
	if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) return; // input/IME handles text
	const key = (event.ctrlKey || event.metaKey) && /^(Key[A-Z]|Digit[0-9])$/.test(event.code) ? event.code : event.key;
	if (
		!/^[\x20-\x7e]$/.test(key) &&
		!/^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/.test(key) &&
		![
			'Backspace',
			'Tab',
			'Enter',
			'Escape',
			'Delete',
			'Insert',
			'Home',
			'End',
			'PageUp',
			'PageDown',
			'ArrowLeft',
			'ArrowRight',
			'ArrowUp',
			'ArrowDown'
		].includes(key)
	)
		return;
	event.preventDefault();
	enqueue({ type: 'key', key, modifiers: modifiers(event) });
}

function beforeInput(event: Event): void {
	const input = event as InputEvent;
	const key = (
		{ deleteContentBackward: 'Backspace', deleteContentForward: 'Delete', insertLineBreak: 'Enter' } as Record<
			string,
			string
		>
	)[input.inputType];
	if (controlled.value && !composing && key) {
		event.preventDefault();
		enqueue({ type: 'key', key });
	}
}

function paste(event: ClipboardEvent): void {
	if (!controlled.value) return;
	event.preventDefault();
	flushText();
	sendText(event.clipboardData?.getData('text/plain') || '');
}

function submitDraft(): void {
	sendText(draft.value);
	draft.value = '';
	keyboard.value?.focus({ preventScroll: true });
}

async function fullscreen(): Promise<void> {
	try {
		if (document.fullscreenElement) await document.exitFullscreen();
		else await panel.value?.requestFullscreen();
	} catch {
		controlError.value = '当前浏览器无法进入全屏。';
	}
}

function visibility(): void {
	if (document.hidden) stopControl();
}

function stop(): void {
	stopControl();
	active.value = false;
	emit('active', false);
	controller?.abort();
	controller = undefined;
	if (image.value) URL.revokeObjectURL(image.value);
	image.value = '';
	viewport.value = undefined;
}

async function start(): Promise<void> {
	stop();
	if (!props.pageId) return;
	active.value = true;
	emit('active', true);
	error.value = '';
	const local = new AbortController();
	controller = local;
	try {
		let response: Response;
		// The previous page's stream can take a moment to close on the server.
		for (let attempt = 0; ; attempt++) {
			response = await fetch(
				`${apiBase()}/api/v1/browsers/${encodeURIComponent(props.browserId)}/preview?pageId=${encodeURIComponent(
					props.pageId
				)}`,
				{
					headers: { Authorization: `Bearer ${currentBearer()}` },
					signal: local.signal
				}
			);
			if (response.status !== 409 || attempt >= 20 || local.signal.aborted) break;
			await response.body?.cancel();
			await new Promise((resolve) => setTimeout(resolve, 100));
			if (local.signal.aborted) return;
		}
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
					const headers = new TextDecoder().decode(buffer.slice(0, end));
					const length = Number(headers.match(/Content-Length:\s*(\d+)/i)?.[1]);
					if (!length || length > 2 * 1024 * 1024) throw new Error('实时预览帧格式无效');
					if (buffer.length < end + length + 2) break;
					const frame = buffer.slice(end, end + length);
					buffer = buffer.slice(end + length + 2);
					if (local.signal.aborted) return;
					const previous = image.value;
					image.value = URL.createObjectURL(new Blob([frame], { type: 'image/jpeg' }));
					viewport.value = {
						width: Number(headers.match(/X-Viewport-Width:\s*(\d+)/i)?.[1]),
						height: Number(headers.match(/X-Viewport-Height:\s*(\d+)/i)?.[1])
					};
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
			stopControl();
			active.value = false;
			emit('active', false);
			controller = undefined;
		}
	}
}

watch(
	() => [props.browserId, props.pageId],
	() => void start(),
	{ immediate: true }
);
onMounted(() => {
	window.addEventListener('blur', stopControl);
	window.addEventListener('pagehide', stop);
	document.addEventListener('visibilitychange', visibility);
});
onBeforeUnmount(() => {
	stop();
	window.removeEventListener('blur', stopControl);
	window.removeEventListener('pagehide', stop);
	document.removeEventListener('visibilitychange', visibility);
});
defineExpose({ stopControl });
</script>

<template>
	<section
		ref="panel"
		class="panel live-preview"
		:class="{ 'is-controlled': controlled }"
	>
		<header class="panel__head">
			<span class="panel__title"
				>实时画面
				<span
					v-if="controlled"
					class="tag tag--ok"
					>直接操作</span
				></span
			>
			<div class="live-preview__tools">
				<BaseButton
					size="sm"
					:disabled="!active || !image || !viewport?.width || !viewport?.height"
					:busy="controlBusy"
					@click="controlled ? stopControl() : startControl()"
					>{{ controlled ? '仅查看' : '直接操作' }}</BaseButton
				>
				<BaseButton
					size="sm"
					:disabled="!image"
					@click="fullscreen"
					>全屏</BaseButton
				>
				<BaseButton
					size="sm"
					:disabled="!pageId"
					@click="active ? stop() : start()"
					>{{ active ? '停止预览' : '开始预览' }}</BaseButton
				>
			</div>
		</header>
		<div class="live-preview__surface">
			<img
				v-if="image"
				:src="image"
				alt="浏览器实时画面"
				:draggable="false"
				@click="click($event)"
				@contextmenu="click($event, 'right')"
				@wheel="wheel"
			/>
			<textarea
				ref="keyboard"
				class="remote-keyboard"
				aria-label="远程键盘输入"
				:tabindex="controlled ? 0 : -1"
				:disabled="!controlled"
				autocomplete="off"
				autocapitalize="off"
				:spellcheck="false"
				@keydown="keydown"
				@beforeinput="beforeInput"
				@input="flushText"
				@compositionstart="composing = true"
				@compositionend="compositionEnd"
				@paste="paste"
			></textarea>
		</div>
		<form
			v-if="controlled"
			class="live-preview__text"
			@submit.prevent="submitDraft"
		>
			<textarea
				v-model="draft"
				aria-label="发送到远端的文字"
				placeholder="输入文字或中文，发送到远端焦点"
				rows="1"
				maxlength="10000"
			></textarea>
			<BaseButton
				type="submit"
				size="sm"
				:disabled="!draft"
				>发送文字</BaseButton
			>
		</form>
		<p
			v-if="controlled"
			class="live-preview__hint"
		>
			点击画面后可输入、滚动；Ctrl + Alt + Esc 退出直接操作。
		</p>
		<p
			v-if="active && !image"
			class="empty"
		>
			等待画面…
		</p>
		<p
			v-if="controlError"
			class="inline-error live-preview__error"
		>
			{{ controlError }}
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
	min-width: 0;
}
.live-preview:fullscreen {
	background: var(--bg-1, #101315);
	overflow: auto;
}
.live-preview .panel__head {
	flex-wrap: wrap;
	gap: 10px;
}
.live-preview__tools {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}
.live-preview__surface {
	position: relative;
	min-width: 0;
	background: rgba(0, 0, 0, 0.3);
}
.is-controlled .live-preview__surface {
	outline: 1px solid var(--accent);
	outline-offset: -1px;
}
.remote-keyboard {
	position: absolute;
	left: 0;
	top: 0;
	width: 1px;
	height: 1px;
	opacity: 0;
	padding: 0;
	border: 0;
	resize: none;
}
.live-preview__text {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 12px 16px;
}
.live-preview__text textarea {
	flex: 1;
	min-width: 0;
	resize: vertical;
	padding: 8px;
	color: var(--text-1);
	background: transparent;
	border: 1px solid var(--line-2);
}
.live-preview__hint {
	padding: 0 16px 12px;
	font-size: 10.5px;
	color: var(--text-3);
}
.live-preview__error,
.live-preview > .inline-error {
	margin: 12px 16px;
}
.is-controlled img {
	cursor: crosshair;
}
.is-controlled .live-preview__surface {
	user-select: none;
}
.live-preview .panel__title .tag {
	margin-left: 8px;
}
.live-preview:fullscreen img {
	max-width: 1365px;
	margin: 0 auto;
}
.live-preview img {
	display: block;
	width: 100%;
	height: auto;
}
</style>
