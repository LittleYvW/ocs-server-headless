<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import AppIcon from './AppIcon.vue';
import { session, logout } from '@/stores/session';
import { feed } from '@/stores/events';
import { service } from '@/stores/service';

const router = useRouter();

const items = [
	{ to: '/', label: '运行态势', index: '01', icon: 'grid' },
	{ to: '/instances', label: '实例', index: '02', icon: 'browser' },
	{ to: '/scripts', label: '用户脚本', index: '03', icon: 'code' },
	{ to: '/settings', label: '平台设置', index: '04', icon: 'settings' },
	{ to: '/events', label: '事件', index: '05', icon: 'events' }
];

const link = computed(() => {
	switch (feed.status) {
		case 'live':
			return { text: '实时连接', className: 'link-state--live' };
		case 'connecting':
			return { text: '正在连接', className: 'link-state--retry' };
		case 'retrying':
			return { text: '连接中断 · 重试中', className: 'link-state--retry' };
		case 'paused':
			return { text: '事件流已暂停', className: '' };
		case 'denied':
			return { text: '事件流被拒绝', className: 'link-state--down' };
		default:
			return { text: '事件流离线', className: 'link-state--down' };
	}
});

const running = computed(() => service.browsers.filter((item) => item.runtime.status === 'running').length);
const capacity = computed(() => service.system?.maxBrowsers ?? 0);

function endSession(): void {
	logout();
	void router.replace('/');
}
</script>

<template>
	<aside class="rail">
		<RouterLink
			to="/"
			class="brand"
			aria-label="返回概览"
		>
			<span class="brand__glyph"></span>
			<span>
				<span class="brand__name">OCS</span>
				<span class="brand__sub">Headless</span>
			</span>
		</RouterLink>

		<div class="rail__group">
			<p class="rail__label">Console</p>
			<nav
				class="nav"
				aria-label="主导航"
			>
				<RouterLink
					v-for="item in items"
					:key="item.to"
					:to="item.to"
					class="nav-item"
					active-class="is-active"
				>
					<span class="nav-item__index">{{ item.index }}</span>
					<span>{{ item.label }}</span>
				</RouterLink>
			</nav>
		</div>

		<div class="rail__foot">
			<button
				type="button"
				class="link-state"
				:class="link.className"
				@click="router.push('/events')"
			>
				<span class="link-state__dot"></span>
				<span>{{ link.text }}</span>
			</button>
			<p class="rail__meta">
				<span>API v{{ service.system?.apiVersion ?? '—' }}</span
				><br />
				<span>{{ running }}/{{ capacity || '—' }} 运行中</span><br />
				<span>{{ session.remembered ? 'token · localStorage' : 'token · session' }}</span>
			</p>
			<button
				type="button"
				class="rail__logout"
				@click="endSession"
			>
				<AppIcon
					name="power"
					:size="13"
				/>
				<span>断开连接</span>
			</button>
		</div>
	</aside>
</template>
