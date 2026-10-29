import { ApiError } from './client';

const messages: Record<string, string> = {
	UNAUTHORIZED: '令牌无效或已过期，请重新连接。',
	ORIGIN_DENIED: '来源被拒绝：请把当前地址加入 OCS_ALLOWED_ORIGINS 后重启服务。',
	BROWSER_BUSY: '实例正在启动、运行或停止，先停止后再修改配置。',
	BROWSER_LIMIT: '已达到并发容量上限，先停止其他实例。',
	BROWSER_NOT_RUNNING: '实例未运行，启动后才能查看页面或执行操作。',
	PAGE_NOT_FOUND: '页面已失效，刷新页面列表后重试。',
	BROWSER_OPERATION_FAILED: '浏览器操作失败，检查选择器与页面状态。',
	BROWSER_TIMEOUT: '浏览器操作超时，稍后重试。',
	START_FAILED: '浏览器启动失败：检查浏览器安装与系统依赖。',
	START_CANCELLED: '浏览器启动已取消。',
	BROWSER_STOPPING: '实例正在停止，请稍后重试。',
	WORKER_UNAVAILABLE: '浏览器 worker 不可用，请重试。',
	WORKER_FAILED: '浏览器 worker 异常，检查服务日志。',
	WORKER_EXITED: '浏览器进程已退出。',
	SHUTTING_DOWN: '服务正在关闭。',
	SCRIPT_IN_USE: '仍有实例引用该脚本，先停止实例并解除关联。',
	LIMIT_REACHED: '已达到服务端数量上限。',
	BODY_TOO_LARGE: '提交内容超过服务端大小限制。',
	NETWORK_ERROR: '无法连接管理服务，检查服务是否运行。',
	NOT_FOUND: '资源不存在或已被删除。',
	INTERNAL_ERROR: '服务端内部错误。'
};

/** Server error messages are diagnostics, not localised UI copy. Prefer stable codes. */
export function describeError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 403) return messages.ORIGIN_DENIED;
		if (error.status === 401) return messages.UNAUTHORIZED;
		if (error.code === 'INVALID_REQUEST' || error.code === 'INVALID_JSON') {
			return error.message || '请求参数不合法。';
		}
		return messages[error.code] || error.message || `请求失败（HTTP ${error.status}）`;
	}
	if (error instanceof DOMException && error.name === 'AbortError') return '请求已取消。';
	return error instanceof Error ? error.message : '未知错误。';
}
