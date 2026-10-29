<script setup lang="ts">
import { computed } from 'vue';
import type { RuntimeStatus } from '@/api/types';

const props = withDefaults(defineProps<{ status?: RuntimeStatus; dotOnly?: boolean }>(), {
	status: 'stopped',
	dotOnly: false
});

const labels: Record<RuntimeStatus, string> = {
	starting: '启动中',
	running: '运行中',
	stopping: '停止中',
	stopped: '已停止',
	error: '异常'
};

const label = computed(() => labels[props.status] || '未知');
</script>

<template>
	<span
		class="status"
		:class="`status--${status}`"
		:title="label"
	>
		<span class="status__dot"></span>
		<span v-if="!dotOnly">{{ label }}</span>
	</span>
</template>
