<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import PageHead from '@/components/PageHead.vue';
import BankClientsPanel from '@/components/question-bank/BankClientsPanel.vue';
import BankImportPanel from '@/components/question-bank/BankImportPanel.vue';
import BankLogsPanel from '@/components/question-bank/BankLogsPanel.vue';
import BankQueriesPanel from '@/components/question-bank/BankQueryPanel.vue';
import BankQuestionsPanel from '@/components/question-bank/BankQuestionsPanel.vue';
import BankSettingsPanel from '@/components/question-bank/BankSettingsPanel.vue';
import {
	available,
	bank,
	configured,
	loadClients,
	loadFolders,
	loadLogs,
	loadQuestions,
	loadSettings,
	openBank,
	queryEnabled,
	refreshStatus,
	resetBank,
	toggleQuery
} from '@/stores/question-bank';
import { relativeTime } from '@/lib/format';

type Tab = 'questions' | 'settings' | 'import' | 'clients' | 'query' | 'logs';
type Tone = 'ok' | 'warn' | 'bad' | 'dim';

const tab = ref<Tab>('questions');
const visitedQuery = ref(false);

const tabs = computed(() => [
	{ key: 'questions' as Tab, label: '题目', count: bank.status?.stats?.questions },
	{ key: 'settings' as Tab, label: '设置' },
	{ key: 'import' as Tab, label: '导入' },
	{ key: 'clients' as Tab, label: '客户端', count: bank.status?.stats?.tokens },
	{ key: 'query' as Tab, label: '查询验证' },
	{ key: 'logs' as Tab, label: '日志' }
]);

const stale = computed(() => !!bank.statusError && bank.status !== null);

const health = computed<{ label: string; tone: Tone; hint: string; statusClass: string }>(() => {
	const status = bank.status;
	if (!status) {
		if (bank.statusError)
			return {
				label: '连接失败',
				tone: 'bad',
				hint: bank.statusError,
				statusClass: 'status--error'
			};
		return { label: '正在读取', tone: 'dim', hint: '正在读取服务状态…', statusClass: 'status--starting' };
	}
	if (status.configured === false)
		return {
			label: '未接入',
			tone: 'dim',
			hint: '部署配置未提供题库地址与内部令牌，需由运维启用后再使用此页面。',
			statusClass: 'status--stopped'
		};
	if (!status.available)
		return {
			label: '连接失败',
			tone: 'bad',
			hint: '主服务无法连接题库服务，检查题库容器、地址与内部令牌。',
			statusClass: 'status--error'
		};
	if (status.enabled === false)
		return {
			label: '查询暂停',
			tone: 'warn',
			hint: '服务在线，查询入口已暂停；题目、文件夹与客户端管理仍可用。',
			statusClass: 'status--starting'
		};
	return {
		label: '查询可用',
		tone: 'ok',
		hint: '查询入口已接纳请求，管理功能同时可用。',
		statusClass: 'status--running'
	};
});

/** A failed read never presents the last snapshot as a healthy service. */
const statusText = computed(() => (stale.value ? '状态未知' : health.value.label));
const statusClass = computed(() => (stale.value ? 'status--starting' : health.value.statusClass));

const tagClass = computed(() => {
	if (stale.value) return 'tag--warn';
	if (health.value.tone === 'ok') return 'tag--ok';
	if (health.value.tone === 'warn') return 'tag--warn';
	if (health.value.tone === 'bad') return 'tag--bad';
	return 'tag--dim';
});

const stats = computed(() => bank.status?.stats ?? { questions: 0, tokens: 0 });
const limits = computed(() => bank.status?.limits);
const lastRead = computed(() => (bank.statusAt ? relativeTime(bank.statusAt) : ''));

const ready = computed(() => configured.value && available.value);

function selectTab(key: Tab): void {
	tab.value = key;
	if (key === 'query') visitedQuery.value = true;
}

async function sync(): Promise<void> {
	await refreshStatus();
	if (!ready.value) return;
	await Promise.all([loadSettings(), loadFolders(), loadQuestions(), loadClients()]);
	if (bank.logsVisible) await loadLogs();
}

function toggleService(): void {
	if (!ready.value) return;
	void toggleQuery(!queryEnabled.value);
}

onMounted(() => {
	void openBank();
});

onBeforeUnmount(() => {
	resetBank();
});
</script>

<template>
	<PageHead
		kicker="Question Bank / 06"
		title="题库服务"
		note="独立题库服务的题目、文件夹、模型设置、客户端接入与查询验证。管理接口使用现有管理令牌，查询使用独立令牌。"
	>
		<template #actions>
			<span
				class="tag"
				:class="tagClass"
				>{{ statusText }}</span
			>
			<BaseButton
				size="sm"
				variant="ghost"
				:busy="bank.statusLoading"
				title="重新读取状态与管理数据"
				@click="sync"
			>
				<AppIcon
					name="refresh"
					:size="13"
				/>
				同步
			</BaseButton>
			<BaseButton
				v-if="ready"
				size="sm"
				:variant="queryEnabled ? 'line' : 'primary'"
				:busy="bank.statusPending"
				@click="toggleService"
			>
				<AppIcon
					:name="queryEnabled ? 'pause' : 'play'"
					:size="12"
				/>
				{{ queryEnabled ? '暂停查询' : '启用查询' }}
			</BaseButton>
		</template>
	</PageHead>

	<div class="link-line">
		<span
			class="link-line__pulse"
			:class="{ 'is-idle': !bank.statusLoading }"
			aria-hidden="true"
		></span>
		<span
			class="status link-state-text"
			:class="statusClass"
		>
			<span class="status__dot"></span>
			<span>{{ statusText }}</span>
		</span>
		<span class="tag tag--dim mono">ai {{ bank.status?.aiEnabled ? 'on' : 'off' }}</span>
		<span
			v-if="bank.status?.version"
			class="tag tag--dim mono"
			>v{{ bank.status.version }}</span
		>
		<span
			v-if="stale"
			class="tag tag--warn"
			>上次成功读取 {{ lastRead }} · {{ bank.statusError }}</span
		>
		<span
			v-else-if="lastRead"
			class="dim small mono"
			>read {{ lastRead }}</span
		>
	</div>

	<section
		v-if="!bank.status"
		class="panel notice"
	>
		<div class="notice__body">
			<p class="notice__title">{{ bank.statusError ? '无法读取题库状态' : '正在读取服务状态' }}</p>
			<p
				v-if="bank.statusError"
				class="notice__text"
			>
				{{ bank.statusError }}
			</p>
			<p class="notice__text dim">浏览器实例管理不受影响，可以继续在其他页面操作。</p>
			<BaseButton
				size="sm"
				variant="primary"
				:busy="bank.statusLoading"
				:disabled="!bank.statusError"
				@click="sync"
				>重新连接</BaseButton
			>
		</div>
	</section>

	<section
		v-else-if="bank.status.configured === false || !bank.status.available"
		class="panel notice"
	>
		<div class="notice__body">
			<p class="notice__title">{{ bank.status.configured === false ? '题库服务尚未接入' : '题库服务不可用' }}</p>
			<p class="notice__text">{{ health.hint }}</p>
			<ul class="notice__list">
				<li>
					需由部署配置提供 <span class="mono">OCS_QUESTION_BANK_URL</span> 与
					<span class="mono">OCS_QUESTION_BANK_TOKEN_FILE</span>，该配置无法在此页面修改。
				</li>
				<li>未接入时禁止提交设置或调用无效地址；页面不会伪造可用的统计与开关。</li>
			</ul>
			<BaseButton
				size="sm"
				variant="primary"
				:busy="bank.statusLoading"
				@click="sync"
				>重试</BaseButton
			>
		</div>
	</section>

	<template v-else>
		<div class="metrics bank-metrics">
			<div class="metric">
				<span class="metric__label">Questions</span>
				<span class="metric__value">{{ stats.questions }}</span>
				<span class="metric__foot">本地题库记录</span>
			</div>
			<div class="metric">
				<span class="metric__label">Clients</span>
				<span class="metric__value">{{ stats.tokens }}</span>
				<span class="metric__foot">独立查询令牌</span>
			</div>
			<div class="metric">
				<span class="metric__label">Concurrency</span>
				<span class="metric__value">{{ limits?.maxConcurrent ?? '—' }}<em v-if="limits">全局</em></span>
				<span class="metric__foot"
					>每令牌 {{ limits?.perTokenConcurrent ?? '—' }} 并发 · {{ limits?.perTokenPerMinute ?? '—' }} 次/分</span
				>
			</div>
			<div class="metric">
				<span class="metric__label">Budget</span>
				<span class="metric__value">{{ limits?.timeoutSeconds ?? '—' }}<em>秒</em></span>
				<span class="metric__foot">覆盖查库、同题判断、请求与重试</span>
			</div>
		</div>

		<nav
			class="tabs bank-tabs"
			aria-label="题库服务分区"
		>
			<button
				v-for="item in tabs"
				:key="item.key"
				type="button"
				class="tab"
				:class="{ 'is-active': tab === item.key }"
				:aria-pressed="tab === item.key"
				@click="selectTab(item.key)"
			>
				{{ item.label }}
				<span
					v-if="typeof item.count === 'number'"
					class="tab__count mono"
					>{{ item.count }}</span
				>
			</button>
		</nav>

		<BankQuestionsPanel
			v-if="tab === 'questions'"
			key="questions"
		/>
		<BankSettingsPanel
			v-else-if="tab === 'settings'"
			key="settings"
		/>
		<BankImportPanel
			v-else-if="tab === 'import'"
			key="import"
		/>
		<BankClientsPanel
			v-else-if="tab === 'clients'"
			key="clients"
		/>
		<BankLogsPanel
			v-else-if="tab === 'logs'"
			key="logs"
		/>
		<div
			v-if="visitedQuery"
			v-show="tab === 'query'"
		>
			<BankQueriesPanel key="query" />
		</div>
	</template>
</template>

<style scoped>
.link-line {
	display: flex;
	align-items: center;
	flex-wrap: wrap;
	gap: 12px;
	margin: 18px 0 0;
	padding-bottom: 14px;
	border-bottom: 1px solid var(--line-1);
}

.link-line__pulse {
	position: relative;
	width: 64px;
	height: 1px;
	background: var(--line-2);
	overflow: hidden;
}

.link-line__pulse::after {
	content: '';
	position: absolute;
	inset: 0 auto 0 0;
	width: 26px;
	background: var(--accent);
	animation: pulse-slide 2.6s var(--ease) infinite;
}

.link-line__pulse.is-idle::after {
	animation: none;
	opacity: 0.35;
}

@keyframes pulse-slide {
	0% {
		transform: translateX(-110%);
	}
	60%,
	100% {
		transform: translateX(280%);
	}
}

.link-state-text {
	font-size: 11px;
}

.bank-metrics {
	margin: 26px 0 4px;
}

.bank-tabs {
	margin-top: 22px;
}

.tab {
	font-family: inherit;
}

.notice {
	margin-top: 26px;
}

.notice__body {
	display: flex;
	flex-direction: column;
	align-items: flex-start;
	gap: 12px;
	padding: 26px 22px;
}

.notice__title {
	font-size: 15px;
	font-weight: 400;
	color: var(--text-1);
}

.notice__text {
	font-size: 12.5px;
	line-height: 1.7;
	color: var(--text-2);
	max-width: 720px;
}

.notice__list {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 0;
	padding-left: 16px;
	font-size: 11.5px;
	line-height: 1.6;
	color: var(--text-3);
}

@media (max-width: 760px) {
	.link-line__pulse {
		width: 40px;
	}
}
</style>
