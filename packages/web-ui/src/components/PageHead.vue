<script setup lang="ts">
withDefaults(defineProps<{ kicker: string; title: string; note?: string }>(), { note: '' });
</script>

<template>
	<header class="page-head">
		<div class="page-head__main">
			<p class="kicker">{{ kicker }}</p>
			<h1 class="display">{{ title }}</h1>
			<p
				v-if="note"
				class="note"
			>
				{{ note }}
			</p>
		</div>
		<div
			v-if="$slots.actions"
			class="page-head__actions"
		>
			<slot name="actions" />
		</div>
	</header>
	<div class="rule"></div>
</template>
