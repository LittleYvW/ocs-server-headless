import type { ServiceEvent } from '@/api/types';

export function shortId(id: string): string {
	return id.slice(0, 8);
}

/** Runtime errors are stable English diagnostics; surface a short Chinese hint. */
export function runtimeMessage(message: string): string {
	if (!message) return '';
	if (/startup failed/i.test(message)) return '浏览器启动失败：检查浏览器安装与系统依赖。';
	if (/exited unexpectedly/i.test(message)) return '浏览器进程异常退出。';
	if (/could not start/i.test(message)) return '浏览器 worker 无法启动。';
	return message;
}

export function formatBytes(size: number): string {
	if (!Number.isFinite(size) || size < 0) return '—';
	if (size < 1024) return `${size} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = size / 1024;
	let index = 0;
	while (value >= 1024 && index < units.length - 1) {
		value /= 1024;
		index += 1;
	}
	return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
	hour12: false
});

const dateTimeFormat = new Intl.DateTimeFormat('zh-CN', {
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hour12: false
});

export function formatClock(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '—' : timeFormat.format(date);
}

export function formatStamp(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? '—' : dateTimeFormat.format(date);
}

export function relativeTime(iso: string): string {
	const date = new Date(iso);
	const delta = Date.now() - date.getTime();
	if (Number.isNaN(delta)) return '—';
	if (delta < 45_000) return '刚刚';
	if (delta < 3_600_000) return `${Math.round(delta / 60_000)} 分钟前`;
	if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)} 小时前`;
	if (delta < 30 * 86_400_000) return `${Math.round(delta / 86_400_000)} 天前`;
	return date.toLocaleDateString('zh-CN');
}

export function downloadLabel(filename: string): string {
	return filename.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}--/i, '');
}

const stateLabels: Record<string, string> = {
	starting: '启动中',
	running: '运行中',
	stopping: '停止中',
	stopped: '已停止',
	error: '异常',
	completed: '完成'
};

export function stateLabel(value: string): string {
	return stateLabels[value] || value;
}

export function eventLabel(type: string): string {
	const labels: Record<string, string> = {
		'browser-state': '实例状态',
		'browser.created': '实例创建',
		'browser.updated': '实例更新',
		'browser.deleted': '实例删除',
		'browser-error': '浏览器异常',
		'page-created': '页面创建',
		'page-closed': '页面关闭',
		'page-error': '页面异常',
		'automation-started': '自动化开始',
		'automation-warning': '自动化提示',
		'automation-result': '自动化结果',
		'download-completed': '下载完成',
		'download-error': '下载失败',
		'userscript-result': '脚本结果',
		'userscript.created': '脚本创建',
		'userscript.updated': '脚本更新',
		'userscript.deleted': '脚本删除',
		'settings.updated': '设置更新',
		'server.started': '服务启动',
		'server.stopping': '服务停止'
	};
	return labels[type] || type;
}

export function eventSummary(event: ServiceEvent): string {
	const data = (event.data || {}) as Record<string, unknown>;
	const value = (key: string) => (typeof data[key] === 'string' ? (data[key] as string) : '');
	switch (event.type) {
		case 'browser-state':
			return stateLabel(value('status'));
		case 'automation-started':
			return value('name');
		case 'automation-warning':
			return [value('name'), value('code') === 'OCR_UNAVAILABLE' ? '未提供 OCR，验证码可能导致登录失败' : value('code')]
				.filter(Boolean)
				.join(' · ');
		case 'automation-result':
			return [value('name'), stateLabel(value('status'))].filter(Boolean).join(' · ');
		case 'download-completed':
			return downloadLabel(value('filename'));
		case 'download-error':
		case 'browser-error':
		case 'page-error':
			return value('code');
		case 'userscript-result':
			return `${shortId(value('scriptId'))} · ${stateLabel(value('status'))}`;
		case 'userscript.created':
		case 'userscript.updated':
		case 'userscript.deleted':
			return value('scriptId') ? shortId(value('scriptId')) : '';
		case 'page-created':
		case 'page-closed':
			return value('pageId') ? shortId(value('pageId')) : '';
		case 'browser.created':
		case 'browser.updated':
		case 'browser.deleted':
			return value('profileId') ? shortId(value('profileId')) : '';
		default:
			return Object.keys(data).length ? JSON.stringify(data) : '';
	}
}

export function profileOf(event: ServiceEvent): string {
	const data = (event.data || {}) as Record<string, unknown>;
	return typeof data.profileId === 'string' ? data.profileId : '';
}
