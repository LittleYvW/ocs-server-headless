<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import EmptyState from '@/components/EmptyState.vue';
import { bank, loadLogs, setLogsVisible } from '@/stores/question-bank';
import { formatDuration, logSourceCopy, logStatusCopy, sqliteUtcToIso } from '@/lib/question-bank';
import { formatClock, formatStamp } from '@/lib/format';

onMounted(() => {
	setLogsVisible(true);
	void loadLogs();
});

onBeforeUnmount(() => setLogsVisible(false));

const updatedAt = computed(() => bank.logsAt || '');

function shortId(value: string): string {
	return value ? value.slice(0, 8) : '—';
}
</script>

<template>
	<section class="panel logs-panel">
		<header class="panel__head">
			<div class="head-line">
				<span class="panel__title">Logs</span>
				<span class="tag tag--dim mono">最近 100 条</span>
			</div>
			<div class="head-tools">
				<span
					v-if="updatedAt"
					class="dim small mono"
					>read {{ formatClock(updatedAt) }}</span
				>
				<BaseButton
					size="sm"
					variant="ghost"
					:busy="bank.logsLoading"
					@click="loadLogs()"
				>
					<AppIcon
						name="refresh"
						:size="13"
					/>
					刷新
				</BaseButton>
			</div>
		</header>

		<p
			v-if="bank.logsError"
			class="inline-error table-note"
			role="alert"
		>
			{{ bank.logsError }}
		</p>

		<div class="table-head log-grid">
			<span>时间</span>
			<span>请求</span>
			<span class="log-client">客户端</span>
			<span>状态</span>
			<span class="log-duration">耗时</span>
			<span>来源</span>
			<span class="log-error">错误码</span>
		</div>

		<div
			v-if="bank.logs.length"
			class="rows"
		>
			<div
				v-for="item in bank.logs"
				:key="item.id"
				class="row log-grid"
			>
				<span class="mono dim log-time">{{ formatStamp(sqliteUtcToIso(item.timestamp)) }}</span>
				<span class="mono dim">{{ shortId(item.id) }}</span>
				<span class="mono dim log-client">{{ shortId(item.tokenId) }}</span>
				<span>
					<span
						class="tag mono"
						:class="logStatusCopy(item.status).className"
						>{{ logStatusCopy(item.status).label }}</span
					>
				</span>
				<span class="mono dim log-duration">{{ formatDuration(item.durationMs) }}</span>
				<span>
					<span
						class="tag"
						:class="logSourceCopy(item.source).className"
						>{{ logSourceCopy(item.source).label }}</span
					>
				</span>
				<span class="mono log-error">{{ item.errorCode || '—' }}</span>
			</div>
		</div>
		<EmptyState
			v-else
			:text="bank.logsLoading ? '正在读取日志…' : '尚无请求记录。'"
		/>

		<footer class="panel__foot logs-foot">
			<span> 日志只有元数据：不含题干、答案、请求头或供应商原始错误，离开页面后不能从日志重新打开记录。 </span>
			<span class="mono dim">ai-or-cache ≠ 本次收费调用</span>
		</footer>
	</section>
</template>

<style scoped>
.logs-panel {
	margin-bottom: 18px;
}

.head-line {
	display: flex;
	align-items: center;
	gap: 10px;
}

.head-tools {
	display: flex;
	align-items: center;
	gap: 10px;
}

.table-note {
	margin: 12px 18px 0;
}

.log-grid {
	grid-template-columns: 96px 74px 74px 62px 72px 92px minmax(0, 1fr);
}

.log-time {
	font-size: 10.5px;
}

.log-duration {
	font-size: 10.5px;
}

.log-error {
	font-size: 10.5px;
	color: var(--text-3);
	overflow-wrap: anywhere;
}

.logs-foot {
	flex-wrap: wrap;
	gap: 8px 18px;
}

@media (max-width: 1080px) {
	.log-grid {
		grid-template-columns: 92px 66px 62px 72px minmax(0, 1fr);
	}

	.log-client,
	.log-duration {
		display: none;
	}
}

@media (max-width: 620px) {
	.log-grid {
		grid-template-columns: 84px 58px 72px minmax(0, 1fr);
	}

	.log-error {
		display: none;
	}
}
</style>
