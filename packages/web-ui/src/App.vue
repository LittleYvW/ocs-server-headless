<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView } from 'vue-router';
import FlowField from '@/components/FlowField.vue';
import ToastStack from '@/components/ToastStack.vue';
import SideRail from '@/components/SideRail.vue';
import ConnectView from '@/views/ConnectView.vue';
import { session, boot } from '@/stores/session';
import { loadAll, resetService } from '@/stores/service';
import { startFeed, stopFeed } from '@/stores/events';

watch(
	() => session.authenticated,
	async (authenticated) => {
		if (authenticated) {
			await loadAll();
			await startFeed();
		} else {
			stopFeed();
			resetService();
		}
	}
);

onMounted(() => {
	void boot();
});
</script>

<template>
	<FlowField />
	<ToastStack />
	<div class="app-layer">
		<div
			v-if="!session.ready"
			class="boot"
		>
			<div class="boot__line"><span></span></div>
			<p class="boot__label mono">ESTABLISHING SESSION</p>
		</div>
		<ConnectView v-else-if="!session.authenticated" />
		<div
			v-else
			class="shell"
		>
			<SideRail />
			<main class="main">
				<div class="page">
					<RouterView v-slot="{ Component }">
						<Transition
							name="page"
							mode="out-in"
						>
							<component :is="Component" />
						</Transition>
					</RouterView>
				</div>
			</main>
		</div>
	</div>
</template>

<style scoped>
.boot {
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 18px;
	min-height: 100vh;
}

.boot__line {
	position: relative;
	width: 180px;
	height: 1px;
	background: var(--line-1);
	overflow: hidden;
}

.boot__line span {
	position: absolute;
	top: 0;
	left: 0;
	width: 38%;
	height: 1px;
	background: var(--accent);
	animation: boot-slide 1.4s var(--ease) infinite;
}

.boot__label {
	font-size: 9px;
	letter-spacing: 0.32em;
	color: var(--text-3);
}

@keyframes boot-slide {
	0% {
		transform: translateX(-110%);
	}
	100% {
		transform: translateX(320%);
	}
}
</style>
