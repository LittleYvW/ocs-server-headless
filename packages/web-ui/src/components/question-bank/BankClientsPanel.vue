<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import EmptyState from '@/components/EmptyState.vue';
import { bank, createConnection, dismissConnection, loadClients, revokeClient } from '@/stores/question-bank';
import { sqliteUtcToIso } from '@/lib/question-bank';
import { formatStamp, relativeTime } from '@/lib/format';
import { toast } from '@/stores/toasts';
import type { QuestionBankClient } from '@/api/types';

const name = ref('');
const baseUrl = ref(window.location.origin);
const formError = ref('');
const pendingRevoke = ref<QuestionBankClient | null>(null);
const revoking = ref(false);

const wrapperText = computed(() => JSON.stringify(bank.connection?.wrapper ?? [], null, 2));
const pending = computed(() => !!pendingRevoke.value);

watch(
	() => bank.connection,
	(connection) => {
		if (connection) {
			name.value = '';
			formError.value = '';
		}
	}
);

function urlProblem(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return '请填写客户端可访问的主服务 Base URL。';
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return 'Base URL 不是合法地址。';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Base URL 只支持 http 或 https。';
	if (parsed.username || parsed.password || parsed.search || parsed.hash)
		return 'Base URL 不能包含账号、查询参数或片段。';
	if (trimmed.length > 2000) return 'Base URL 过长。';
	return '';
}

async function submit(): Promise<void> {
	if (bank.connecting) return;
	if (!name.value.trim()) {
		formError.value = '请为客户端填写名称。';
		return;
	}
	const problem = urlProblem(baseUrl.value);
	if (problem) {
		formError.value = problem;
		return;
	}
	formError.value = '';
	const ok = await createConnection(name.value, baseUrl.value);
	if (!ok) formError.value = bank.clientsError || '生成配置失败。';
}

async function copy(text: string, label: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		toast(`已复制${label}`, 'ok');
	} catch {
		toast('浏览器拒绝写入剪贴板，请手动选择文本复制。', 'error');
	}
}

async function confirmRevoke(): Promise<void> {
	const target = pendingRevoke.value;
	if (!target || revoking.value) return;
	revoking.value = true;
	await revokeClient(target.id);
	revoking.value = false;
	pendingRevoke.value = null;
}
</script>

<template>
	<div class="clients-layout">
		<section class="panel">
			<header class="panel__head">
				<span class="panel__title">New Client</span>
				<span class="tag tag--dim mono">POST /connections</span>
			</header>
			<div class="client-body">
				<label class="field">
					<span class="field__label">客户端名称</span>
					<span class="field__control">
						<input
							v-model="name"
							maxlength="100"
							placeholder="例如 外部浏览器"
							aria-label="客户端名称"
							@keydown.enter.prevent="submit"
						/>
					</span>
					<span class="field__hint">每个浏览器或用户使用独立客户端，便于单独撤销。</span>
				</label>

				<label class="field">
					<span class="field__label">主服务 Base URL</span>
					<span class="field__control">
						<input
							v-model="baseUrl"
							maxlength="2000"
							spellcheck="false"
							aria-label="主服务 Base URL"
							@keydown.enter.prevent="submit"
						/>
					</span>
					<span class="field__hint"> 默认当前控制台地址，可按访问位置修改。外部客户端填写它能访问的 HTTPS 地址。 </span>
				</label>

				<ul class="address-notes">
					<li>
						本项目受管浏览器可使用容器内部
						<span class="mono">http://127.0.0.1:15319</span>，主机映射端口不等于容器内部端口。
					</li>
					<li>其他容器中的 <span class="mono">localhost</span> 不会指向本服务，应使用 Compose 服务名或入口地址。</li>
					<li>脚本管理器需允许请求该域名。</li>
				</ul>

				<p
					v-if="formError"
					class="inline-error"
					role="alert"
				>
					{{ formError }}
				</p>

				<div class="client-actions">
					<BaseButton
						variant="primary"
						:busy="bank.connecting"
						@click="submit"
					>
						<AppIcon
							name="link"
							:size="13"
						/>
						生成配置
					</BaseButton>
					<span class="dim small">只有点击后才创建令牌。</span>
				</div>
			</div>
		</section>

		<section
			v-if="bank.connection"
			class="panel connection-panel"
		>
			<header class="panel__head">
				<div class="head-line">
					<span class="panel__title">Issued</span>
					<span class="tag tag--warn">仅本次显示</span>
				</div>
				<button
					type="button"
					class="icon-btn"
					aria-label="关闭本次结果"
					title="关闭并清除内存中的令牌"
					@click="dismissConnection"
				>
					<AppIcon
						name="close"
						:size="13"
					/>
				</button>
			</header>
			<div class="client-body">
				<div class="cred-row">
					<span class="field__label">查询地址</span>
					<span class="mono cred">{{ bank.connection.queryUrl }}</span>
					<button
						type="button"
						class="field__action"
						@click="copy(bank.connection.queryUrl, '查询地址')"
					>
						复制
					</button>
				</div>
				<div class="cred-row">
					<span class="field__label">查询令牌</span>
					<span class="mono cred cred--secret">{{ bank.connection.client.token }}</span>
					<button
						type="button"
						class="field__action"
						@click="copy(bank.connection.client.token, '查询令牌')"
					>
						复制
					</button>
				</div>

				<p class="inline-note">
					<AppIcon
						name="lock"
						:size="13"
					/>
					<span>配置内含查询令牌，按凭据处理：不要发到聊天或日志。离开本页后不再显示原文。</span>
				</p>

				<div class="wrapper">
					<div class="wrapper__head">
						<span class="field__label">wrapper · OCS 自定义题库</span>
						<BaseButton
							size="sm"
							variant="ghost"
							@click="copy(wrapperText, '连接配置')"
							>复制 JSON</BaseButton
						>
					</div>
					<pre class="code wrapper__code">{{ wrapperText }}</pre>
				</div>

				<p class="dim small">
					导入 OCS 的“自定义题库”即可，用户脚本源码无需修改。生成配置不代表已安装或已同步；本页不会覆盖已有题库或
					<span class="mono">settings.ocs</span>。
				</p>
			</div>
		</section>

		<section class="panel">
			<header class="panel__head">
				<span class="panel__title">Clients</span>
				<div class="head-line">
					<span class="dim small mono">{{ bank.clients.length }}</span>
					<BaseButton
						size="sm"
						variant="ghost"
						:busy="bank.clientsLoading"
						@click="loadClients"
						>刷新</BaseButton
					>
				</div>
			</header>

			<p
				v-if="bank.clientsError"
				class="inline-error table-note"
				role="alert"
			>
				{{ bank.clientsError }}
			</p>

			<div class="table-head client-grid">
				<span>名称</span>
				<span>前缀</span>
				<span class="client-time">创建</span>
				<span class="client-time">最近使用</span>
				<span aria-hidden="true"></span>
			</div>

			<div
				v-if="bank.clients.length"
				class="rows"
			>
				<div
					v-for="client in bank.clients"
					:key="client.id"
					class="row client-grid"
				>
					<span class="client-name">{{ client.name }}</span>
					<span class="mono dim">{{ client.prefix }}…</span>
					<span class="client-time dim mono">{{ formatStamp(sqliteUtcToIso(client.createdAt)) }}</span>
					<span class="client-time dim">{{
						client.lastUsedAt ? relativeTime(sqliteUtcToIso(client.lastUsedAt)) : '从未使用'
					}}</span>
					<span class="client-tools">
						<button
							type="button"
							class="icon-btn icon-btn--danger"
							title="撤销客户端"
							aria-label="撤销客户端"
							@click="pendingRevoke = client"
						>
							<AppIcon
								name="trash"
								:size="12"
							/>
						</button>
					</span>
				</div>
			</div>
			<EmptyState
				v-else
				:text="bank.clientsLoading ? '正在读取客户端…' : '尚未创建查询客户端。'"
			/>

			<footer class="panel__foot">
				<span>列表只有名称与前缀，不能找回旧令牌；丢失时新建并撤销旧客户端。</span>
			</footer>
		</section>

		<ConfirmDialog
			:open="pending"
			title="撤销客户端"
			:message="`将撤销「${pendingRevoke?.name ?? ''}」的查询令牌。`"
			note="撤销后后续查询立即返回 401；已经接纳的请求可能完成。管理员登录不受影响。"
			confirm-text="撤销"
			:danger="true"
			:busy="revoking"
			@cancel="pendingRevoke = null"
			@confirm="confirmRevoke"
		/>
	</div>
</template>

<style scoped>
.clients-layout {
	display: flex;
	flex-direction: column;
	gap: 18px;
}

.client-body {
	display: flex;
	flex-direction: column;
	gap: 16px;
	padding: 18px;
}

.address-notes {
	display: flex;
	flex-direction: column;
	gap: 6px;
	margin: 0;
	padding: 12px 14px;
	border: 1px solid var(--line-1);
	list-style: none;
	font-size: 11px;
	line-height: 1.6;
	color: var(--text-3);
}

.address-notes li {
	position: relative;
	padding-left: 12px;
}

.address-notes li::before {
	content: '';
	position: absolute;
	left: 0;
	top: 9px;
	width: 5px;
	height: 1px;
	background: var(--line-3);
}

.client-actions {
	display: flex;
	align-items: center;
	gap: 14px;
	flex-wrap: wrap;
}

.head-line {
	display: flex;
	align-items: center;
	gap: 10px;
}

.cred-row {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 9px 11px;
	border: 1px solid var(--line-1);
}

.cred-row .field__label {
	min-width: 72px;
}

.cred {
	flex: 1;
	min-width: 0;
	font-size: 11px;
	color: var(--text-2);
	overflow-wrap: anywhere;
}

.cred--secret {
	color: var(--warn);
	letter-spacing: 0.04em;
}

.wrapper {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.wrapper__head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.wrapper__code {
	max-height: 260px;
	overflow: auto;
}

.table-note {
	margin: 12px 18px 0;
}

.client-grid {
	grid-template-columns: minmax(0, 1fr) 110px 96px 96px 40px;
}

.client-name {
	font-size: 12.5px;
	color: var(--text-1);
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.client-time {
	font-size: 10.5px;
}

.client-tools {
	display: flex;
	justify-content: flex-end;
	opacity: 0.45;
	transition: opacity 0.16s;
}

.row:hover .client-tools,
.row:focus-within .client-tools {
	opacity: 1;
}

@media (max-width: 900px) {
	.client-grid {
		grid-template-columns: minmax(0, 1fr) 96px 40px;
	}

	.client-time {
		display: none;
	}
}
</style>
