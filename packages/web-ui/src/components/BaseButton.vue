<script setup lang="ts">
withDefaults(
	defineProps<{
		variant?: 'line' | 'primary' | 'ghost' | 'danger';
		size?: 'sm' | 'md';
		type?: 'button' | 'submit';
		busy?: boolean;
		disabled?: boolean;
		title?: string;
		iconOnly?: boolean;
	}>(),
	{
		variant: 'line',
		size: 'md',
		type: 'button',
		busy: false,
		disabled: false,
		title: '',
		iconOnly: false
	}
);
</script>

<template>
	<button
		:type="type"
		class="btn"
		:class="[`btn--${variant}`, `btn--${size}`, { 'btn--icon': iconOnly }]"
		:disabled="disabled || busy"
		:title="title || undefined"
	>
		<span
			v-if="busy"
			class="btn__spin"
			aria-hidden="true"
		></span>
		<slot />
	</button>
</template>
