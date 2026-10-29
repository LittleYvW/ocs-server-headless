import { reactive } from 'vue';
import { api } from '@/api/endpoints';
import { ApiError, setBearer, setUnauthorizedHandler } from '@/api/client';
import { describeError } from '@/api/errors';
import { toast } from './toasts';

const TOKEN_KEY = 'ocs.console.token';
const REMEMBER_KEY = 'ocs.console.remember';

export const session = reactive({
	token: '',
	remembered: false,
	ready: false,
	authenticated: false,
	connecting: false,
	error: ''
});

function readStored(): { token: string; remembered: boolean } {
	try {
		const remembered = localStorage.getItem(REMEMBER_KEY) === '1';
		const rememberedToken = remembered ? localStorage.getItem(TOKEN_KEY) || '' : '';
		if (rememberedToken) return { token: rememberedToken, remembered: true };
		if (remembered) {
			localStorage.removeItem(TOKEN_KEY);
			localStorage.removeItem(REMEMBER_KEY);
		}
		return { token: sessionStorage.getItem(TOKEN_KEY) || '', remembered: false };
	} catch {
		return { token: '', remembered: false };
	}
}

function persist(token: string, remember: boolean): void {
	try {
		localStorage.removeItem(TOKEN_KEY);
		localStorage.removeItem(REMEMBER_KEY);
		sessionStorage.removeItem(TOKEN_KEY);
		if (remember) {
			localStorage.setItem(TOKEN_KEY, token);
			localStorage.setItem(REMEMBER_KEY, '1');
		} else {
			sessionStorage.setItem(TOKEN_KEY, token);
		}
	} catch {
		// Private-mode storage failures leave the token in memory only.
	}
}

function clearStored(): void {
	try {
		localStorage.removeItem(TOKEN_KEY);
		localStorage.removeItem(REMEMBER_KEY);
		sessionStorage.removeItem(TOKEN_KEY);
	} catch {
		// Ignore unavailable storage.
	}
}

function resetState(): void {
	session.token = '';
	session.remembered = false;
	session.authenticated = false;
	session.connecting = false;
	session.error = '';
}

export function expireSession(message = '认证已失效，请重新输入令牌。'): void {
	// A boot probe with a stored token is not an active session yet; let boot()
	// show its own message instead of flashing an authentication toast.
	if (!session.authenticated) return;
	clearStored();
	setBearer('');
	session.token = '';
	session.remembered = false;
	session.authenticated = false;
	session.error = message;
	toast(message, 'error');
}

export async function boot(): Promise<void> {
	const saved = readStored();
	if (!saved.token) {
		session.ready = true;
		return;
	}
	session.token = saved.token;
	session.remembered = saved.remembered;
	setBearer(saved.token);
	try {
		await api.system();
		session.authenticated = true;
		session.error = '';
	} catch (error) {
		session.authenticated = false;
		if (error instanceof ApiError && error.status === 401) {
			clearStored();
			session.token = '';
			session.remembered = false;
			setBearer('');
			session.error = '保存的令牌已失效，请重新连接。';
		} else {
			// Keep the stored token for a later reload, but never treat an
			// unvalidated token as an active session.
			session.token = '';
			setBearer('');
			session.error = describeError(error);
		}
	} finally {
		session.ready = true;
	}
}

export async function connect(tokenInput: string, remember: boolean): Promise<boolean> {
	const token = tokenInput.trim();
	if (!token) {
		session.error = '请输入管理令牌。';
		return false;
	}
	session.connecting = true;
	session.error = '';
	const previous = session.token;
	const wasAuthenticated = session.authenticated;
	setBearer(token);
	try {
		await api.system();
		session.token = token;
		session.remembered = remember;
		session.authenticated = true;
		persist(token, remember);
		return true;
	} catch (error) {
		setBearer(previous);
		session.authenticated = wasAuthenticated;
		session.error = describeError(error);
		return false;
	} finally {
		session.connecting = false;
	}
}

export function logout(): void {
	clearStored();
	setBearer('');
	resetState();
}

export function forgetRemembered(): void {
	if (!session.remembered) return;
	try {
		localStorage.removeItem(TOKEN_KEY);
		localStorage.removeItem(REMEMBER_KEY);
		if (session.token) sessionStorage.setItem(TOKEN_KEY, session.token);
	} catch {
		// Ignore unavailable storage.
	}
	session.remembered = false;
	toast('已清除浏览器保存的令牌', 'ok');
}

setUnauthorizedHandler(() => {
	expireSession();
});
