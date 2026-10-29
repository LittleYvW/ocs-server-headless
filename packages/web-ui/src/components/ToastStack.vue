<script setup lang="ts">
import AppIcon from './AppIcon.vue';
import { useToasts, type ToastKind } from '@/stores/toasts';

const { items, dismiss } = useToasts();

const icons: Record<ToastKind, string> = {
	ok: 'check',
	error: 'warning',
	info: 'dot'
};
</script>

<template>
	<TransitionGroup
		tag="div"
		name="toast"
		class="toasts"
		aria-live="polite"
	>
		<div
			v-for="item in items"
			:key="item.id"
			class="toast"
			:class="`toast--${item.kind}`"
			role="status"
		>
			<AppIcon
				:name="icons[item.kind]"
				:size="14"
			/>
			<span class="toast__text">{{ item.text }}</span>
			<button
				type="button"
				class="toast__close"
				aria-label="关闭提示"
				@click="dismiss(item.id)"
			>
				<AppIcon
					name="close"
					:size="12"
				/>
			</button>
		</div>
	</TransitionGroup>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
	transition: opacity 0.2s var(--ease), transform 0.2s var(--ease);
}

.toast-enter-from,
.toast-leave-to {
	opacity: 0;
	transform: translateY(4px);
}
</style>
