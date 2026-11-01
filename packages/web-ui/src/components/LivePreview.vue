<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import BaseButton from './BaseButton.vue';
import { apiBase, currentBearer } from '@/api/client';
import { api } from '@/api/endpoints';
import { describeError } from '@/api/errors';
import type { BrowserControlSession, BrowserElement, BrowserInputEvent, InputModifier } from '@/api/types';
import { InputChannel } from '@/lib/browser-input';

const props = defineProps<{ browserId: string; pageId: string }>();
const emit = defineEmits<{
	active: [active: boolean];
	changed: [];
	picked: [target: BrowserElement & { pageId: string; action: 'click' | 'fill' }];
}>();
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
const picking = ref(false);
const frozenPick = ref(false);
const inspected = ref<BrowserElement | null>(null);
const inspecting = ref(false);
const dragging = ref(false);
const pickerText = ref<HTMLTextAreaElement>();
const overlay = computed(() => {
	if (!picking.value || !inspected.value || !viewport.value) return undefined;
	const { bounds } = inspected.value;
	return {
		left: `${(bounds.x / viewport.value.width) * 100}%`,
		top: `${(bounds.y / viewport.value.height) * 100}%`,
		width: `${(bounds.width / viewport.value.width) * 100}%`,
		height: `${(bounds.height / viewport.value.height) * 100}%`
	};
});
const pickedLocator = computed(() =>
	inspected.value?.framePath.length
		? JSON.stringify({ selector: inspected.value.selector, framePath: inspected.value.framePath }, null, 2)
		: inspected.value?.selector || ''
);
let controller: AbortController | undefined;
let session: BrowserControlSession | undefined;
let sessionBrowserId = '';
let channel: InputChannel | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let compositionTimer: ReturnType<typeof setTimeout> | undefined;
let composing = false;
let controlGeneration = 0;
let controlTransition: Promise<void> = Promise.resolve();
type Position = { x: number; y: number };
let pointer:
	| {
			id: number;
			target: HTMLImageElement;
			button: 'left' | 'middle' | 'right';
			count: number;
			start: Position;
			last: Position;
			moved: boolean;
	  }
	| undefined;
let lastClick: { time: number; position: Position; button: string; count: number } | undefined;
let moveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingMove: Position | undefined;
let inspectTimer: ReturnType<typeof setTimeout> | undefined;
let pendingInspection: Position | undefined;
let inspectionId = 0;

function resetPointer(): void {
	const previous = pointer;
	pointer = undefined;
	dragging.value = false;
	try {
		if (previous?.target.hasPointerCapture(previous.id)) previous.target.releasePointerCapture(previous.id);
	} catch {
		/* The image may already be detached. */
	}
}

function resetPicker(): void {
	inspectionId++;
	clearTimeout(inspectTimer);
	inspectTimer = undefined;
	pendingInspection = undefined;
	picking.value = false;
	frozenPick.value = false;
	inspected.value = null;
	inspecting.value = false;
}

function stopControl(): void {
	resetPointer();
	resetPicker();
	clearTimeout(moveTimer);
	moveTimer = undefined;
	pendingMove = undefined;
	lastClick = undefined;
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
				if (session === acquired && events.some((event) => ['click', 'pointer-up', 'key'].includes(event.type)))
					emit('changed');
				if (session === acquired && picking.value) {
					const latest = result.inspections?.find((result) => result.requestId === inspectionId);
					if (latest) {
						inspecting.value = false;
						inspected.value = latest.element;
						if (!latest.element && frozenPick.value) {
							controlError.value = '此位置未找到可定位元素，可移动鼠标重试。';
							frozenPick.value = false;
						}
					}
				}
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

function point(event: MouseEvent, clamp = false): Position | undefined {
	if (!controlled.value || !session || !(event.currentTarget instanceof HTMLImageElement)) return;
	if (viewport.value?.width !== session.viewport.width || viewport.value?.height !== session.viewport.height) {
		controlError.value = '远端画面尺寸已变化，请重新开启直接操作。';
		stopControl();
		return;
	}
	// The image has its natural aspect ratio, without object-fit letterboxing.
	const bounds = event.currentTarget.getBoundingClientRect();
	let x = (event.clientX - bounds.left) / bounds.width;
	let y = (event.clientY - bounds.top) / bounds.height;
	if (clamp) {
		x = Math.max(0, Math.min(0.999999, x));
		y = Math.max(0, Math.min(0.999999, y));
	}
	if (bounds.width && bounds.height && x >= 0 && y >= 0 && x < 1 && y < 1) return { x, y };
}

function inspect(position: Position, freeze: boolean): void {
	clearTimeout(inspectTimer);
	inspectTimer = undefined;
	pendingInspection = undefined;
	frozenPick.value = freeze;
	inspecting.value = true;
	inspected.value = null;
	enqueue({ type: 'inspect', ...position, requestId: ++inspectionId });
}

function flushMove(): void {
	clearTimeout(moveTimer);
	moveTimer = undefined;
	const position = pendingMove;
	pendingMove = undefined;
	if (position && !picking.value) enqueue({ type: 'move', ...position });
}

function pointerMove(event: PointerEvent): void {
	const position = point(event, !!pointer);
	if (!position) return;
	if (picking.value) {
		if (frozenPick.value) return;
		pendingInspection = position;
		if (!inspectTimer)
			inspectTimer = setTimeout(() => {
				inspectTimer = undefined;
				if (pendingInspection) inspect(pendingInspection, false);
			}, 100);
		return;
	}
	if (pointer) {
		if (pointer.id !== event.pointerId) return;
		pointer.last = position;
		if (Math.hypot(position.x - pointer.start.x, position.y - pointer.start.y) > 0.004) pointer.moved = true;
	}
	pendingMove = position;
	if (!moveTimer) moveTimer = setTimeout(flushMove, 33);
}

function pointerDown(event: PointerEvent): void {
	const position = point(event);
	if (!position || pointer || !event.isPrimary || ![0, 1, 2].includes(event.button)) return;
	event.preventDefault();
	keyboard.value?.focus({ preventScroll: true });
	if (picking.value) {
		if (event.button === 0) inspect(position, true);
		return;
	}
	const button = (['left', 'middle', 'right'] as const)[event.button];
	const count =
		lastClick &&
		lastClick.count === 1 &&
		lastClick.button === button &&
		performance.now() - lastClick.time < 450 &&
		Math.hypot(position.x - lastClick.position.x, position.y - lastClick.position.y) < 0.004
			? 2
			: 1;
	flushMove();
	pointer = {
		id: event.pointerId,
		target: event.currentTarget as HTMLImageElement,
		button,
		count,
		start: position,
		last: position,
		moved: false
	};
	dragging.value = true;
	enqueue({ type: 'pointer-down', ...position, button, clickCount: count, modifiers: modifiers(event) });
	try {
		pointer.target.setPointerCapture(event.pointerId);
	} catch {
		cancelPointer();
	}
}

function pointerUp(event: PointerEvent): void {
	if (!pointer || pointer.id !== event.pointerId) return;
	event.preventDefault();
	const previous = pointer;
	const position = point(event, true) || previous.last;
	flushMove();
	resetPointer();
	enqueue({ type: 'pointer-up', ...position, button: previous.button });
	lastClick = previous.moved
		? undefined
		: { time: performance.now(), position, button: previous.button, count: previous.count };
}

function cancelPointer(): void {
	if (!pointer) return;
	clearTimeout(moveTimer);
	moveTimer = undefined;
	pendingMove = undefined;
	resetPointer();
	lastClick = undefined;
	enqueue({ type: 'pointer-cancel' });
}

function pointerLeave(): void {
	if (pointer) return; // pointer capture still delivers the drag's final move/up outside the image
	clearTimeout(moveTimer);
	moveTimer = undefined;
	pendingMove = undefined;
	if (picking.value) {
		if (!frozenPick.value) {
			inspectionId++;
			clearTimeout(inspectTimer);
			inspectTimer = undefined;
			pendingInspection = undefined;
			inspected.value = null;
			inspecting.value = false;
		}
	} else if (controlled.value) enqueue({ type: 'pointer-cancel' });
}

async function togglePicker(): Promise<void> {
	if (picking.value) {
		resetPicker();
		return;
	}
	if (!controlled.value) await startControl();
	if (!controlled.value || dragging.value) return;
	clearTimeout(moveTimer);
	moveTimer = undefined;
	pendingMove = undefined;
	resetPicker();
	picking.value = true;
	controlError.value = '';
	keyboard.value?.focus({ preventScroll: true });
}

function usePicked(action: 'click' | 'fill'): void {
	if (!inspected.value || !frozenPick.value || !session) return;
	emit('picked', { ...inspected.value, pageId: session.pageId, action });
}

async function copyPicked(): Promise<void> {
	try {
		await navigator.clipboard.writeText(pickedLocator.value);
	} catch {
		pickerText.value?.select();
		controlError.value = '定位信息已选中，可按 Ctrl+C 复制。';
	}
}

function wheel(event: WheelEvent): void {
	const position = point(event);
	if (!position || !session) return;
	event.preventDefault();
	if (dragging.value || picking.value) return;
	flushMove();
	const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? session.viewport.height : 1;
	const delta = (value: number) => Math.max(-10000, Math.min(10000, value * scale));
	enqueue({ type: 'wheel', ...position, deltaX: delta(event.deltaX), deltaY: delta(event.deltaY) });
}

function sendText(value: string): void {
	if (!value || picking.value || dragging.value) return;
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

function cancelGesture(event: KeyboardEvent): void {
	if (!controlled.value || event.key !== 'Escape') return;
	if (event.ctrlKey && event.altKey) {
		event.preventDefault();
		event.stopPropagation();
		stopControl();
	} else if (picking.value || dragging.value) {
		event.preventDefault();
		event.stopPropagation();
		if (picking.value) resetPicker();
		else cancelPointer();
	}
}

function keydown(event: KeyboardEvent): void {
	if (!controlled.value || event.isComposing || composing || event.key === 'Process' || event.key === 'Dead') return;
	if (picking.value || dragging.value) {
		event.preventDefault();
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
	if (picking.value || dragging.value) {
		event.preventDefault();
		return;
	}
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
		:class="{ 'is-controlled': controlled, 'is-picking': picking }"
		@keydown.capture="cancelGesture"
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
					:variant="picking ? 'primary' : 'line'"
					:disabled="!active || !image || controlBusy || dragging"
					@click="togglePicker"
					>{{ picking ? '结束拾取' : '拾取元素' }}</BaseButton
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
			<div class="live-preview__viewport">
				<img
					v-if="image"
					:src="image"
					alt="浏览器实时画面"
					:draggable="false"
					@pointerdown="pointerDown"
					@pointermove="pointerMove"
					@pointerup="pointerUp"
					@pointercancel="cancelPointer"
					@lostpointercapture="cancelPointer"
					@pointerleave="pointerLeave"
					@contextmenu="controlled && $event.preventDefault()"
					@wheel="wheel"
				/>
				<div
					v-if="overlay"
					class="element-highlight"
					:style="overlay"
					aria-hidden="true"
				>
					<span>{{ inspected?.tag }}</span>
				</div>
			</div>
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
		<div
			v-if="picking"
			class="element-picker"
		>
			<p class="live-preview__hint">
				{{ inspecting ? '正在定位元素…' : frozenPick ? '已选中元素' : '移动鼠标查看元素，单击选中；Esc 退出拾取。' }}
			</p>
			<template v-if="frozenPick && inspected && !inspecting">
				<label class="field"
					><span class="field__label">{{
						inspected.framePath.length ? '拾取的定位信息（含框架范围）' : '拾取的选择器'
					}}</span
					><textarea
						ref="pickerText"
						class="element-selector mono"
						:value="pickedLocator"
						aria-label="拾取的选择器"
						readonly
						rows="2"
					></textarea>
				</label>
				<div class="live-preview__tools">
					<BaseButton
						size="sm"
						@click="copyPicked"
						>复制定位信息</BaseButton
					>
					<BaseButton
						size="sm"
						@click="usePicked('click')"
						>用于点击</BaseButton
					>
					<BaseButton
						size="sm"
						@click="usePicked('fill')"
						>用于填充</BaseButton
					>
					<BaseButton
						size="sm"
						@click="
							resetPicker();
							picking = true;
						"
						>重新拾取</BaseButton
					>
				</div>
			</template>
		</div>
		<form
			v-if="controlled && !picking"
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
			v-if="controlled && !picking"
			class="live-preview__hint"
		>
			可悬停、拖拽、双击和输入；Ctrl + Alt + Esc 退出直接操作。
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
.live-preview:fullscreen .live-preview__viewport {
	max-width: 1365px;
	margin: 0 auto;
}
.live-preview__viewport {
	position: relative;
	overflow: hidden;
}
.is-controlled img {
	touch-action: none;
	cursor: default;
}
.is-picking img {
	cursor: crosshair;
}
.element-highlight {
	position: absolute;
	pointer-events: none;
	border: 1px solid var(--accent);
	background: var(--accent-soft);
}
.element-highlight span {
	position: absolute;
	left: 0;
	top: 0;
	padding: 2px 5px;
	background: var(--ink-2);
	color: var(--accent);
	font-size: 10px;
}
.element-picker {
	display: grid;
	gap: 12px;
	padding: 14px 16px;
}
.element-picker .live-preview__hint {
	padding: 0;
}
.element-selector {
	width: 100%;
	resize: vertical;
	padding: 8px;
	color: var(--text-1);
	background: transparent;
	border: 1px solid var(--line-2);
	font-size: 11px;
}
.live-preview img {
	display: block;
	width: 100%;
	height: auto;
}
</style>
