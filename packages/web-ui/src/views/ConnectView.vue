<script setup lang="ts">
import { computed, ref } from 'vue';
import { apiBase } from '@/api/client';
import { connect, session } from '@/stores/session';
import AppIcon from '@/components/AppIcon.vue';
import BaseButton from '@/components/BaseButton.vue';
import BaseSwitch from '@/components/BaseSwitch.vue';

const token = ref('');
const remember = ref(session.remembered);
const reveal = ref(false);
const endpoint = computed(() => `${apiBase()} /api/v1`);

async function submit(): Promise<void> {
	if (session.connecting) return;
	const ok = await connect(token.value, remember.value);
	if (ok) token.value = '';
}
</script>

<template>
	<main class="connect">
		<section class="connect__frame">
			<div class="connect__top">
				<span class="connect__mark">OCS</span>
				<span class="connect__edition mono">Headless / Console</span>
			</div>

			<h1 class="connect__title">无头浏览器控制台</h1>
			<p class="connect__lead">输入服务端管理令牌以建立管理会话。</p>

			<form
				class="connect__form"
				@submit.prevent="submit"
			>
				<label class="field">
					<span class="field__label">管理令牌 <span class="field__required">required</span></span>
					<span class="field__control">
						<span class="field__lead"
							><AppIcon
								name="lock"
								:size="13"
						/></span>
						<input
							v-model="token"
							:type="reveal ? 'text' : 'password'"
							autocomplete="current-password"
							spellcheck="false"
							placeholder="Bearer token"
							aria-label="管理令牌"
						/>
						<button
							type="button"
							class="field__action"
							:aria-label="reveal ? '隐藏令牌' : '显示令牌'"
							@click="reveal = !reveal"
						>
							<AppIcon
								:name="reveal ? 'eye-off' : 'eye'"
								:size="15"
							/>
						</button>
					</span>
				</label>

				<div class="connect__remember">
					<BaseSwitch
						v-model="remember"
						label="记住令牌"
						>记住令牌</BaseSwitch
					>
					<p class="connect__hint">
						{{ remember ? '保存在此浏览器 localStorage，可在「平台设置」清除。' : '仅保存在当前标签页会话。' }}
					</p>
				</div>

				<div
					v-if="session.error"
					class="inline-error"
				>
					{{ session.error }}
				</div>

				<BaseButton
					type="submit"
					variant="primary"
					class="connect__submit"
					:busy="session.connecting"
				>
					建立连接
				</BaseButton>
				<div
					v-if="session.connecting"
					class="connect__progress"
					aria-hidden="true"
				>
					<span></span>
				</div>
			</form>

			<footer class="connect__foot mono">
				<span class="truncate">{{ endpoint }}</span>
				<span>token · admin.token</span>
			</footer>
		</section>
	</main>
</template>

<style scoped>
.connect {
	display: grid;
	place-items: center;
	min-height: 100vh;
	padding: 48px 24px;
}

.connect__frame {
	width: min(460px, 100%);
}

.connect__top {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 14px;
	padding-bottom: 14px;
	border-bottom: 1px solid var(--line-1);
}

.connect__mark {
	font-family: var(--font-mono);
	font-size: 22px;
	letter-spacing: 0.36em;
	line-height: 1;
}

.connect__edition {
	font-size: 8px;
	letter-spacing: 0.3em;
	text-transform: uppercase;
	color: var(--text-3);
}

.connect__title {
	margin-top: 34px;
	font-size: clamp(28px, 4.4vw, 36px);
	font-weight: 300;
	letter-spacing: -0.02em;
	line-height: 1.15;
}

.connect__lead {
	margin-top: 10px;
	font-size: 13px;
	color: var(--text-2);
}

.connect__form {
	display: flex;
	flex-direction: column;
	gap: 22px;
	margin-top: 38px;
}

.connect__remember {
	display: flex;
	flex-direction: column;
	gap: 7px;
}

.connect__hint {
	font-size: 11px;
	line-height: 1.5;
	color: var(--text-3);
}

.connect__submit {
	width: 100%;
	height: 38px;
}

.connect__progress {
	position: relative;
	height: 1px;
	background: var(--line-1);
	overflow: hidden;
}

.connect__progress span {
	position: absolute;
	top: 0;
	left: 0;
	width: 30%;
	height: 1px;
	background: var(--accent);
	animation: connect-slide 1.3s var(--ease) infinite;
}

.connect__foot {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	margin-top: 46px;
	padding-top: 14px;
	border-top: 1px solid var(--line-1);
	font-size: 9px;
	letter-spacing: 0.1em;
	text-transform: uppercase;
	color: var(--text-3);
}

@keyframes connect-slide {
	0% {
		transform: translateX(-120%);
	}
	100% {
		transform: translateX(370%);
	}
}
</style>
