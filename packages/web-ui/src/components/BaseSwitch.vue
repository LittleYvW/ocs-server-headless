<script setup lang="ts">
const props = withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean; label?: string }>(), {
	disabled: false,
	label: ''
});
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

function toggle(): void {
	if (props.disabled) return;
	emit('update:modelValue', !props.modelValue);
}
</script>

<template>
	<span
		class="sw"
		@click="toggle"
	>
		<button
			type="button"
			class="sw__track"
			role="switch"
			:aria-checked="modelValue"
			:disabled="disabled"
			:aria-label="label || undefined"
			@click.stop="toggle"
		>
			<span class="sw__dot"></span>
		</button>
		<span
			v-if="$slots.default"
			class="sw__text"
			><slot
		/></span>
	</span>
</template>
