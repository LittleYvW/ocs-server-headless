<script setup lang="ts">
import { computed, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import EventList from '@/components/EventList.vue';
import PageHead from '@/components/PageHead.vue';
import { clearFeed, eventProfileId, feed, loadLogs, pauseFeed, resumeFeed } from '@/stores/events';
import { service } from '@/stores/service';
import { eventLabel } from '@/lib/format';

const typeFilter = ref('');
const instanceFilter = ref('');
const limit = ref(120);

const types = computed(() => {
	const counts = new Map<string, number>();
	for (const event of feed.items) counts.set(event.type, (counts.get(event.type) || 0) + 1);
	return [...counts.entries()]
		.sort((left, right) => right[1] - left[1])
		.map(([type, count]) => ({ type, count, label: eventLabel(type) }));
});

const filtered = computed(() => {
	const list = feed.items.filter(
		(event) =>
			(!typeFilter.value || event.type === typeFilter.value) &&
			(!instanceFilter.value || eventProfileId(event) === instanceFilter.value)
	);
	return list.slice(-limit.value).reverse();
});

const statusMeta = computed(() => {
	switch (feed.status) {
		case 'live':
			return { label: '实时连接', className: 'tag--ok' };
		case 'connecting':
			return { label: '连接中', className: 'tag--warn' };
		case 'retrying':
			return { label: '重连中', className: 'tag--warn' };
		case 'paused':
			return { label: '已暂停', className: 'tag--dim' };
		case 'denied':
			return { label: '被拒绝', className: 'tag--bad' };
		default:
			return { label: '离线', className: 'tag--bad' };
	}
});

function togglePause(): void {
	if (feed.paused) resumeFeed();
	else pauseFeed();
}
</script>

<template>
	<PageHead
		kicker="Events / 05"
		title="事件流"
		note="断线后自动重连并重新同步；本地最多保留 400 条事件，不假定服务端永久回放。"
	>
		<template #actions>
			<span
				class="tag"
				:class="statusMeta.className"
				>{{ statusMeta.label }}</span
			>
			<BaseButton
				size="sm"
				variant="ghost"
				title="重新读取近期事件"
				@click="loadLogs()"
			>
				<AppIcon
					name="refresh"
					:size="13"
				/>
				同步
			</BaseButton>
			<BaseButton
				size="sm"
				@click="togglePause"
			>
				<AppIcon
					:name="feed.paused ? 'play' : 'pause'"
					:size="12"
				/>
				{{ feed.paused ? '恢复订阅' : '暂停订阅' }}
			</BaseButton>
		</template>
	</PageHead>

	<section class="panel">
		<header class="panel__head events-head">
			<div class="filters">
				<label class="mini-field">
					<span class="mini-field__label mono">Type</span>
					<span class="field__control mini-field__control">
						<select
							v-model="typeFilter"
							aria-label="按类型过滤"
						>
							<option value="">全部类型</option>
							<option
								v-for="item in types"
								:key="item.type"
								:value="item.type"
							>
								{{ item.label }} · {{ item.count }}
							</option>
						</select>
						<span class="field__chevron"></span>
					</span>
				</label>
				<label class="mini-field">
					<span class="mini-field__label mono">Instance</span>
					<span class="field__control mini-field__control">
						<select
							v-model="instanceFilter"
							aria-label="按实例过滤"
						>
							<option value="">全部实例</option>
							<option
								v-for="item in service.browsers"
								:key="item.id"
								:value="item.id"
							>
								{{ item.name }}
							</option>
						</select>
						<span class="field__chevron"></span>
					</span>
				</label>
				<label class="mini-field">
					<span class="mini-field__label mono">Limit</span>
					<span class="field__control mini-field__control mini-field__control--narrow">
						<select
							v-model.number="limit"
							aria-label="显示条数"
						>
							<option :value="60">60</option>
							<option :value="120">120</option>
							<option :value="240">240</option>
							<option :value="400">400</option>
						</select>
						<span class="field__chevron"></span>
					</span>
				</label>
			</div>
			<div class="events-meta">
				<span class="dim small">{{ filtered.length }} / {{ feed.items.length }}</span>
				<button
					type="button"
					class="btn btn--ghost btn--sm"
					@click="clearFeed"
				>
					清空本地
				</button>
			</div>
		</header>

		<div
			v-if="feed.status === 'retrying'"
			class="stream-note"
		>
			<AppIcon
				name="warning"
				:size="13"
			/>
			<span>{{ feed.detail || '事件流中断，正在退避重连。' }}</span>
		</div>
		<div
			v-else-if="feed.status === 'denied'"
			class="stream-note stream-note--bad"
		>
			<AppIcon
				name="lock"
				:size="13"
			/>
			<span>事件流认证被拒绝，请重新连接或检查来源配置。</span>
		</div>

		<EventList
			:events="filtered"
			show-instance
			empty="暂无匹配事件。"
		/>

		<footer class="panel__foot">
			<span>事件用于状态诊断，不是任务结果数据库。</span>
			<span class="mono">{{ feed.paused ? 'paused' : feed.status }}</span>
		</footer>
	</section>
</template>

<style scoped>
.events-head {
	align-items: flex-end;
	flex-wrap: wrap;
}

.filters {
	display: flex;
	align-items: flex-end;
	flex-wrap: wrap;
	gap: 14px;
}

.mini-field {
	display: flex;
	flex-direction: column;
	gap: 5px;
}

.mini-field__label {
	font-size: 8.5px;
	letter-spacing: 0.2em;
	text-transform: uppercase;
	color: var(--text-3);
}

.mini-field__control {
	min-width: 160px;
}

.mini-field__control select {
	padding: 6px 26px 6px 9px;
	font-size: 11px;
}

.mini-field__control--narrow {
	min-width: 78px;
}

.events-meta {
	display: flex;
	align-items: center;
	gap: 10px;
}

.stream-note {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 9px 18px;
	border-top: 1px solid var(--line-1);
	font-size: 11px;
	color: var(--warn);
	background: var(--warn-soft);
}

.stream-note--bad {
	color: var(--danger);
	background: var(--danger-soft);
}
</style>
