import { createRouter, createWebHashHistory } from 'vue-router';
import OverviewView from './views/OverviewView.vue';
import InstancesView from './views/InstancesView.vue';
import InstanceView from './views/InstanceView.vue';
import ScriptsView from './views/ScriptsView.vue';
import SettingsView from './views/SettingsView.vue';
import EventsView from './views/EventsView.vue';

// Hash history keeps static hosting simple: no server-side SPA rewrites are
// required, and the console works when reverse-proxied under a sub-path.
export const router = createRouter({
	history: createWebHashHistory(),
	routes: [
		{ path: '/', name: 'overview', component: OverviewView, meta: { title: '运行态势' } },
		{ path: '/instances', name: 'instances', component: InstancesView, meta: { title: '实例' } },
		{ path: '/instances/:id', name: 'instance', component: InstanceView, meta: { title: '实例详情' } },
		{ path: '/scripts', name: 'scripts', component: ScriptsView, meta: { title: '用户脚本' } },
		{ path: '/settings', name: 'settings', component: SettingsView, meta: { title: '平台设置' } },
		{ path: '/events', name: 'events', component: EventsView, meta: { title: '事件' } },
		{ path: '/:pathMatch(.*)*', redirect: '/' }
	],
	scrollBehavior: () => ({ top: 0 })
});

router.afterEach((to) => {
	const title = typeof to.meta.title === 'string' ? to.meta.title : '';
	document.title = title ? `${title} · OCS 控制台` : 'OCS · 无头浏览器控制台';
});
