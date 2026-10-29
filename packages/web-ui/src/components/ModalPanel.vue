<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
	defineProps<{
		open: boolean;
		title?: string;
		kicker?: string;
		size?: 'normal' | 'wide' | 'narrow';
		closeOnMask?: boolean;
	}>(),
	{ title: '', kicker: '', size: 'normal', closeOnMask: true }
);
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>();

function onKey(event: KeyboardEvent): void {
	if (event.key === 'Escape' && props.closeOnMask) emit('close');
}

function release(): void {
	document.body.style.overflow = '';
	window.removeEventListener('keydown', onKey);
}

watch(
	() => props.open,
	async (open) => {
		if (open) {
			document.body.style.overflow = 'hidden';
			window.addEventListener('keydown', onKey);
			await nextTick();
			panel.value?.focus();
		} else {
			release();
		}
	}
);

onBeforeUnmount(release);
</script>

<template>
	<Teleport to="body">
		<Transition name="modal">
			<div
				v-if="open"
				class="modal-mask"
				@mousedown.self="closeOnMask && emit('close')"
			>
				<div
					ref="panel"
					class="modal"
					:class="`modal--${size}`"
					role="dialog"
					aria-modal="true"
					tabindex="-1"
				>
					<header class="modal__head">
						<div>
							<p
								v-if="kicker"
								class="kicker"
							>
								{{ kicker }}
							</p>
							<h2 class="modal__title">{{ title }}</h2>
						</div>
						<button
							type="button"
							class="icon-btn"
							aria-label="关闭"
							@click="emit('close')"
						>
							<AppIcon name="close" />
						</button>
					</header>
					<div class="modal__body">
						<slot />
					</div>
					<footer
						v-if="$slots.footer"
						class="modal__foot"
					>
						<slot name="footer" />
					</footer>
				</div>
			</div>
		</Transition>
	</Teleport>
</template>
