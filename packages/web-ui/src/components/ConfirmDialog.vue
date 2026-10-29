<script setup lang="ts">
import ModalPanel from './ModalPanel.vue';
import BaseButton from './BaseButton.vue';

withDefaults(
	defineProps<{
		open: boolean;
		title: string;
		message: string;
		confirmText?: string;
		cancelText?: string;
		danger?: boolean;
		busy?: boolean;
		note?: string;
	}>(),
	{ confirmText: '确认', cancelText: '取消', danger: false, busy: false, note: '' }
);
const emit = defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
	<ModalPanel
		:open="open"
		:title="title"
		size="narrow"
		@close="emit('cancel')"
	>
		<p class="confirm__text">{{ message }}</p>
		<p
			v-if="note"
			class="confirm__note"
		>
			{{ note }}
		</p>
		<template #footer>
			<BaseButton
				variant="ghost"
				:disabled="busy"
				@click="emit('cancel')"
				>{{ cancelText }}</BaseButton
			>
			<BaseButton
				:variant="danger ? 'danger' : 'primary'"
				:busy="busy"
				@click="emit('confirm')"
			>
				{{ confirmText }}
			</BaseButton>
		</template>
	</ModalPanel>
</template>

<style scoped>
.confirm__text {
	font-size: 13px;
	line-height: 1.7;
	color: var(--text-1);
}

.confirm__note {
	margin-top: 10px;
	padding-left: 10px;
	border-left: 1px solid var(--line-2);
	font-size: 11.5px;
	line-height: 1.6;
	color: var(--text-3);
}
</style>
