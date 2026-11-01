/**
 * Question bank console regression with a real browser and the real gateway.
 *
 * Requires the built backend and console:
 *   pnpm build && pnpm build:web
 * Then:
 *   pnpm test:web
 *
 * The OCS server, its /api/v1/question-bank gateway and /question-bank/query
 * proxy, and Chromium are always real. The question bank upstream is the real
 * Rust service when a binary is available (ZERROR_TEST_BINARY or the
 * services/zerror/target/debug build); otherwise a local fixture that
 * implements the documented admin/query contract keeps this suite runnable in
 * Node-only environments. The mode is printed at the start.
 *
 * The provider is a local fixture, so no paid model is ever called.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const packageRoot = path.join(__dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');
const serverEntry = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const webIndex = path.join(repoRoot, 'packages', 'server', 'web', 'index.html');
const token = 'question-bank-e2e-admin-token-1234567890';
const apiKey = 'provider-secret-key-for-e2e';
const aiAnswer = 'AI 生成答案';
const browserPath = process.env.OCS_E2E_BROWSER || '';
const shotsDir = process.env.OCS_E2E_SHOTS || '';

for (const [file, hint] of [
	[serverEntry, 'pnpm build'],
	[webIndex, 'pnpm build:web']
]) {
	if (!fs.existsSync(file)) throw new Error('Missing ' + file + '; run ' + hint + ' first');
}

const bankBinary =
	process.env.ZERROR_TEST_BINARY ||
	path.resolve(
		process.env.CARGO_TARGET_DIR || path.resolve(repoRoot, 'services/zerror/target'),
		'debug',
		'zerror-headless'
	);

/* — Local model provider ————————————————————————————————— */

function startProvider(seen) {
	const server = http.createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		seen.push({ authorization: request.headers.authorization || '', body });
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: aiAnswer }) } }] }));
	});
	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () => resolve({ server, base: 'http://127.0.0.1:' + server.address().port }))
	);
}

/* — Question bank upstream ——————————————————————————————— */

/** Real Rust service when it is built; otherwise the documented contract fixture. */
async function startBank({ dir, tokenFile }) {
	if (fs.existsSync(bankBinary)) {
		const child = spawn(bankBinary, [], {
			env: {
				...process.env,
				ZERROR_DATA_DIR: dir,
				ZERROR_HOST: '127.0.0.1',
				ZERROR_PORT: '0',
				ZERROR_ADMIN_TOKEN_FILE: tokenFile
			},
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let output = '';
		const base = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				reject(new Error('Question bank startup timed out: ' + output));
			}, 20000);
			child.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once('exit', () => {
				clearTimeout(timer);
				reject(new Error('Question bank exited during startup: ' + output));
			});
			child.stdout.on('data', (data) => {
				output += data;
				const found = output.match(/listening on (127\.0\.0\.1:\d+)/);
				if (found) {
					clearTimeout(timer);
					resolve('http://' + found[1]);
				}
			});
			child.stderr.on('data', (data) => {
				output += data;
			});
		});
		return {
			base,
			mode: 'rust',
			async close() {
				if (child.exitCode !== null) return;
				const exited = once(child, 'exit');
				child.kill('SIGTERM');
				const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
				try {
					await exited;
				} finally {
					clearTimeout(timer);
				}
			}
		};
	}
	return startBankFixture({ tokenFile });
}

function startBankFixture({ tokenFile }) {
	const internalToken = crypto.randomBytes(32).toString('hex');
	fs.writeFileSync(tokenFile, internalToken, { mode: 0o600 });
	const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
	const state = {
		settings: {
			enabled: true,
			aiEnabled: false,
			autoCache: true,
			sameQuestionCheck: true,
			timeoutSeconds: 50,
			retryCount: 1,
			model: { protocol: 'openai-chat', baseUrl: '', modelId: '', apiKey: '' }
		},
		folders: [{ id: 0, name: '默认文件夹', parentId: 0 }],
		questions: [],
		tokens: [],
		logs: []
	};
	const redacted = () => {
		const copy = JSON.parse(JSON.stringify(state.settings));
		if (copy.model.apiKey) copy.model.apiKey = '***';
		return copy;
	};
	const folders = () =>
		state.folders.map((folder) => ({
			...folder,
			questionCount: state.questions.filter((question) => question.folderId === folder.id).length
		}));
	const tokens = () =>
		state.tokens.map((entry) => ({
			id: entry.id,
			name: entry.name,
			prefix: entry.prefix,
			createdAt: entry.createdAt,
			lastUsedAt: entry.lastUsedAt
		}));
	const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
	const log = (tokenId, status, source, errorCode, durationMs) => {
		state.logs.unshift({ id: crypto.randomUUID(), timestamp: stamp(), tokenId, status, durationMs, source, errorCode });
		state.logs = state.logs.slice(0, 1000);
	};

	const server = http.createServer(async (request, response) => {
		let body = '';
		for await (const chunk of request) body += chunk;
		const url = new URL(request.url, 'http://bank');
		const send = (status, payload) => {
			response.statusCode = status;
			response.setHeader('Content-Type', 'application/json');
			response.end(JSON.stringify(payload));
		};
		const fail = (status, code, message) => send(status, { code: 0, data: null, message, error: { code, message } });
		const ok = (data, status = 200) => send(status, { data });
		const input = () => (body ? JSON.parse(body) : {});

		if (url.pathname === '/query' && request.method === 'POST') {
			const started = Date.now();
			const authorization = request.headers.authorization || '';
			const raw = authorization.replace(/^Bearer /i, '');
			const entry = state.tokens.find((candidate) => candidate.hash === hash(raw));
			if (!state.settings.enabled) return fail(503, 'SERVICE_PAUSED', 'Queries are paused');
			if (!entry) {
				log('unknown', 401, 'error', 'UNAUTHORIZED', Date.now() - started);
				return fail(401, 'UNAUTHORIZED', 'A valid query token is required');
			}
			entry.lastUsedAt = stamp();
			const payload = input();
			const exact = state.questions.find(
				(question) => question.question === payload.title && (question.options || '') === (payload.options || '')
			);
			if (exact) {
				log(entry.id, 200, exact.isAi ? 'ai-or-cache' : 'local', null, Date.now() - started);
				return send(200, {
					code: 1,
					data: {
						id: exact.id,
						question: exact.question,
						answer: exact.answer,
						is_ai: exact.isAi,
						is_pending_correction: exact.isPendingCorrection
					}
				});
			}
			if (!state.settings.aiEnabled) {
				log(entry.id, 404, 'error', 'NO_MATCH', Date.now() - started);
				return fail(404, 'NO_MATCH', 'No matching question was found and AI fallback is disabled');
			}
			const provider = await fetch(state.settings.model.baseUrl + '/chat/completions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.settings.model.apiKey },
				body: JSON.stringify({
					model: state.settings.model.modelId,
					messages: [{ role: 'user', content: payload.title }]
				})
			});
			const reply = await provider.json();
			const answer = JSON.parse(reply.choices[0].message.content).answer;
			const record = {
				id: state.questions.length + 1,
				question: payload.title,
				options: payload.options || null,
				answer,
				questionType: payload.type || null,
				folderId: 0,
				isAi: true,
				isPendingCorrection: false,
				createdAt: stamp()
			};
			state.questions.push(record);
			log(entry.id, 200, 'ai-or-cache', null, Date.now() - started);
			return send(200, {
				code: 1,
				data: { id: record.id, question: record.question, answer, is_ai: true, is_pending_correction: false }
			});
		}

		if (!url.pathname.startsWith('/admin/')) return fail(404, 'NOT_FOUND', 'Route not found');
		if (request.headers.origin) return fail(401, 'UNAUTHORIZED', 'Internal management authentication is required');
		if (request.headers.authorization !== 'Bearer ' + internalToken)
			return fail(401, 'UNAUTHORIZED', 'Internal management authentication is required');

		const route = url.pathname.slice('/admin'.length);
		const method = request.method;
		const questionId = route.match(/^\/questions\/(\d+)$/);
		const folderId = route.match(/^\/folders\/(\d+)$/);
		const tokenId = route.match(/^\/tokens\/([0-9a-f-]{36})$/);

		if (route === '/status' && method === 'GET')
			return ok({
				service: 'zerror-headless',
				version: 'e2e',
				enabled: state.settings.enabled,
				aiEnabled: state.settings.aiEnabled,
				stats: { questions: state.questions.length, tokens: state.tokens.length },
				limits: {
					maxConcurrent: 8,
					perTokenConcurrent: 2,
					perTokenPerMinute: 60,
					timeoutSeconds: state.settings.timeoutSeconds
				},
				capabilities: [
					'text-query',
					'local-bank',
					'ai-fallback',
					'query-tokens',
					'questions',
					'folders',
					'metadata-logs'
				]
			});
		if (route === '/settings' && method === 'GET') return ok(redacted());
		if (route === '/settings' && method === 'PATCH') {
			const patch = input();
			const next = JSON.parse(JSON.stringify(state.settings));
			for (const [key, value] of Object.entries(patch)) {
				if (key === 'model') {
					for (const [inner, innerValue] of Object.entries(value)) {
						if (inner === 'apiKey' && innerValue === '***') continue;
						next.model[inner] = innerValue;
					}
				} else {
					next[key] = value;
				}
			}
			if (!(next.timeoutSeconds >= 5 && next.timeoutSeconds <= 55) || next.retryCount > 2)
				return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			if (next.aiEnabled && (!next.model.baseUrl || !next.model.modelId))
				return fail(400, 'MODEL_NOT_CONFIGURED', 'Configure the model URL and ID before enabling AI');
			state.settings = next;
			return ok(redacted());
		}
		if (route === '/tokens' && method === 'GET') return ok(tokens());
		if (route === '/tokens' && method === 'POST') {
			const value = crypto.randomBytes(32).toString('hex');
			const entry = {
				id: crypto.randomUUID(),
				name: String(input().name || '').trim(),
				hash: hash(value),
				prefix: value.slice(0, 12),
				createdAt: stamp(),
				lastUsedAt: null
			};
			state.tokens.push(entry);
			return ok({ id: entry.id, name: entry.name, prefix: entry.prefix, token: value });
		}
		if (tokenId && method === 'DELETE') {
			const before = state.tokens.length;
			state.tokens = state.tokens.filter((entry) => entry.id !== tokenId[1]);
			if (state.tokens.length === before) return fail(404, 'NOT_FOUND', 'Resource not found');
			return ok(null);
		}
		if (route === '/folders' && method === 'GET') return ok(folders());
		if (route === '/folders' && method === 'POST') {
			const value = input();
			const folder = { id: state.folders.length, name: value.name.trim(), parentId: value.parentId || 0 };
			state.folders.push(folder);
			return ok(folder);
		}
		if (folderId && method === 'PUT') {
			const target = state.folders.find((folder) => folder.id === Number(folderId[1]));
			if (!target) return fail(404, 'NOT_FOUND', 'Resource not found');
			if (target.id === 0) return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			const value = input();
			target.name = value.name.trim();
			target.parentId = value.parentId || 0;
			return ok({ id: target.id, name: target.name, parentId: target.parentId });
		}
		if (folderId && method === 'DELETE') {
			const id = Number(folderId[1]);
			if (id === 0) return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			const used =
				state.folders.some((folder) => folder.parentId === id) ||
				state.questions.some((question) => question.folderId === id);
			if (used) return fail(409, 'FOLDER_NOT_EMPTY', 'Move or delete the folder contents first');
			const before = state.folders.length;
			state.folders = state.folders.filter((folder) => folder.id !== id);
			if (state.folders.length === before) return fail(404, 'NOT_FOUND', 'Resource not found');
			return ok(null);
		}
		if (route === '/questions' && method === 'GET') {
			const page = Number(url.searchParams.get('page') || 1);
			const limit = Number(url.searchParams.get('limit') || 20);
			const folder = url.searchParams.get('folderId');
			const search = url.searchParams.get('q') || '';
			const filtered = state.questions
				.filter((question) => (folder === null ? true : question.folderId === Number(folder)))
				.filter((question) => !search || question.question.includes(search))
				.slice()
				.sort((left, right) => right.id - left.id);
			return ok({
				items: filtered.slice((page - 1) * limit, page * limit),
				total: filtered.length,
				page,
				limit
			});
		}
		if (route === '/questions' && method === 'POST') {
			const value = input();
			if (!value.question.trim() || !value.answer.trim()) return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			const record = {
				id: state.questions.length + 1,
				question: value.question,
				options: value.options ?? null,
				answer: value.answer,
				questionType: value.questionType ?? null,
				folderId: value.folderId ?? 0,
				isAi: value.isAi ?? false,
				isPendingCorrection: value.isPendingCorrection ?? false,
				createdAt: stamp()
			};
			state.questions.push(record);
			return ok(record);
		}
		if (route === '/questions/import' && method === 'POST') {
			const items = input().questions;
			if (!Array.isArray(items) || items.length < 1 || items.length > 500)
				return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			for (const item of items)
				if (!item.question?.trim() || !item.answer?.trim()) return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			let inserted = 0;
			for (const item of items) {
				const duplicate = state.questions.some(
					(question) =>
						question.question === item.question &&
						(question.options || '') === (item.options || '') &&
						question.answer === item.answer
				);
				if (duplicate) continue;
				state.questions.push({
					id: state.questions.length + 1,
					question: item.question,
					options: item.options ?? null,
					answer: item.answer,
					questionType: item.questionType ?? null,
					folderId: item.folderId ?? 0,
					isAi: item.isAi ?? false,
					isPendingCorrection: item.isPendingCorrection ?? false,
					createdAt: stamp()
				});
				inserted += 1;
			}
			return ok({ inserted, skipped: items.length - inserted });
		}
		if (questionId && method === 'GET') {
			const target = state.questions.find((question) => question.id === Number(questionId[1]));
			return target ? ok(target) : fail(404, 'NOT_FOUND', 'Resource not found');
		}
		if (questionId && method === 'PUT') {
			const target = state.questions.find((question) => question.id === Number(questionId[1]));
			if (!target) return fail(404, 'NOT_FOUND', 'Resource not found');
			const value = input();
			if (!value.question.trim() || !value.answer.trim()) return fail(400, 'INVALID_INPUT', 'Invalid request fields');
			Object.assign(target, {
				question: value.question,
				options: value.options ?? null,
				answer: value.answer,
				questionType: value.questionType ?? null,
				folderId: value.folderId ?? 0,
				isAi: value.isAi ?? false,
				isPendingCorrection: value.isPendingCorrection ?? false
			});
			return ok(target);
		}
		if (questionId && method === 'DELETE') {
			const before = state.questions.length;
			state.questions = state.questions.filter((question) => question.id !== Number(questionId[1]));
			if (state.questions.length === before) return fail(404, 'NOT_FOUND', 'Resource not found');
			return ok(null);
		}
		if (route === '/logs' && method === 'GET') {
			const limit = Number(url.searchParams.get('limit') || 100);
			return ok(state.logs.slice(0, limit));
		}
		return fail(404, 'NOT_FOUND', 'Route not found');
	});

	return new Promise((resolve) =>
		server.listen(0, '127.0.0.1', () =>
			resolve({
				base: 'http://127.0.0.1:' + server.address().port,
				mode: 'fixture',
				close: () => new Promise((done) => server.close(done))
			})
		)
	);
}

async function main() {
	const hardStop = setTimeout(() => {
		console.error('Question bank e2e exceeded the 6 minute limit.');
		process.exit(1);
	}, 6 * 60 * 1000);

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-qb-e2e-'));
	const bankDir = path.join(dir, 'bank');
	fs.mkdirSync(bankDir, { recursive: true });
	const tokenFile = path.join(bankDir, 'admin.token');

	let bank;
	let provider;
	let service;
	let browser;
	let page;

	try {
		const providerSeen = [];
		provider = await startProvider(providerSeen);
		bank = await startBank({ dir: bankDir, tokenFile });
		console.log('  · question bank upstream: ' + bank.mode);

		process.env.OCS_DATA_DIR = path.join(dir, 'ocs');
		process.env.OCS_AUTH_TOKEN = token;
		process.env.OCS_HOST = '127.0.0.1';
		process.env.OCS_PORT = '0';
		process.env.OCS_MAX_BROWSERS = '1';
		process.env.OCS_QUESTION_BANK_URL = bank.base;
		process.env.OCS_QUESTION_BANK_TOKEN_FILE = tokenFile;
		if (browserPath) process.env.OCS_BROWSER_EXECUTABLE_PATH = browserPath;

		const { startServer } = require(serverEntry);
		service = await startServer();
		const base = 'http://127.0.0.1:' + service.server.address().port;

		browser = await chromium.launch({
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			...(browserPath ? { executablePath: browserPath } : {})
		});
		const viewport = (process.env.OCS_E2E_VIEWPORT || '1440x1000').split('x').map(Number);
		const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] } });
		page = await context.newPage();

		const consoleErrors = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

		const report = (message) => console.log('  ✓ ' + message);
		const waitText = async (selector, text, timeout = 20000) => {
			await page.waitForFunction(
				({ selector: target, text: expected }) => {
					const element = document.querySelector(target);
					return !!element && (element.textContent || '').includes(expected);
				},
				{ selector, text },
				{ timeout }
			);
		};
		const saveShot = async (name) => {
			if (!shotsDir) return;
			fs.mkdirSync(shotsDir, { recursive: true });
			for (const button of await page.locator('.toast__close').all()) {
				await button.click({ timeout: 500 }).catch(() => {});
			}
			await page.waitForTimeout(200);
			await page.screenshot({ path: path.join(shotsDir, name), fullPage: true });
		};
		const openTab = async (label) => {
			await page.click(`button.tab:has-text("${label}")`);
		};
		const waitModalsClosed = () =>
			page.waitForFunction(() => document.querySelectorAll('.modal').length === 0, undefined, { timeout: 20000 });
		// Let the real backend finish, but hold its browser response across navigation.
		const holdFirstReply = async (pattern, transform = (value) => value) => {
			let release, announce, fail, finish;
			const gate = new Promise((resolve) => {
				release = resolve;
			});
			const arrived = new Promise((resolve, reject) => {
				announce = resolve;
				fail = reject;
			});
			const finished = new Promise((resolve) => {
				finish = resolve;
			});
			let requests = 0;
			const handler = async (route) => {
				requests += 1;
				if (requests > 1) return route.continue();
				try {
					const response = await route.fetch();
					const payload = transform(await response.json());
					announce(payload);
					await gate;
					await route.fulfill({ response, body: JSON.stringify(payload) }).catch(() => {});
				} catch (error) {
					fail(error);
				} finally {
					finish();
				}
			};
			await page.route(pattern, handler);
			return {
				arrived,
				get requests() {
					return requests;
				},
				async resume() {
					release();
					if (requests) await finished;
					// Give the fulfilled reply time to reach fetch continuations and Vue rendering.
					await page.waitForTimeout(150);
					await page.unroute(pattern, handler);
				}
			};
		};
		const revisitBank = async () => {
			await page.click('a.nav-item:has-text("运行态势")');
			await page.locator('h1:has-text("运行态势")').waitFor();
			await page.click('a.nav-item:has-text("题库服务")');
			await waitText('.link-line .status', '查询可用');
		};

		// Sign in and open the question bank page.
		await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
		await page.locator('.connect__title').waitFor({ timeout: 15000 });
		await page.fill('input[aria-label="管理令牌"]', token);
		await page.click('button:has-text("建立连接")');
		await page.locator('.shell').waitFor({ timeout: 15000 });
		await page.click('a.nav-item:has-text("题库服务")');
		await page.locator('h1:has-text("题库服务")').waitFor();
		await waitText('.link-line .status', '查询可用', 20000);
		report('status shows the question bank as available');
		await saveShot('question-bank-overview.png');

		// Model settings: URL and model ID, a new key, then *** redaction.
		await openTab('设置');
		await page.locator('.bank-settings').waitFor();
		await page.fill('input[aria-label="模型 ID"]', 'e2e-model');
		await page.fill('input[aria-label="模型 Base URL"]', provider.base + '/v1');
		await page.locator('.bank-settings .field__action:has-text("填写")').click();
		await page.fill('input[aria-label="模型 API Key"]', apiKey);
		await page.locator('.sw', { hasText: '启用 AI 答题' }).locator('.sw__track').click();
		await page.locator('.bank-settings .tag:has-text("未保存")').waitFor();
		await page.locator('.bank-settings button:has-text("保存")').click();
		await page.locator('.bank-settings .tag:has-text("已同步")').waitFor({ timeout: 20000 });
		assert.equal((await page.locator('.bank-settings .key-state').textContent()).trim(), '***');
		await waitText('.link-line .tag', 'ai on', 20000);
		report('model settings saved and the API key reads back as ***');
		await saveShot('question-bank-settings.png');

		// Question create, search and edit.
		await openTab('题目');
		await page.locator('.questions-panel').waitFor();
		await page.click('button:has-text("新建题目")');
		await page.locator('.modal').waitFor();
		await page.fill('textarea[aria-label="题干"]', '中国的首都是哪里');
		await page.fill('textarea[aria-label="选项"]', 'A. 北京\nB. 上海');
		await page.fill('textarea[aria-label="答案"]', '北京');
		await page.fill('input[aria-label="题型"]', 'single');
		await page.locator('.modal button:has-text("保存")').click();
		await waitModalsClosed();
		await page.locator('.q-row', { hasText: '中国的首都是哪里' }).waitFor({ timeout: 20000 });
		report('question created from the console');

		await page.fill('input[aria-label="搜索题干"]', '不存在的题干');
		await page.locator('.empty:has-text("当前条件下没有题目")').waitFor({ timeout: 20000 });
		await page.fill('input[aria-label="搜索题干"]', '首都');
		await page.locator('.q-row', { hasText: '中国的首都是哪里' }).waitFor({ timeout: 20000 });
		report('server-side search filters and restores the list');

		await page.locator('.q-row', { hasText: '中国的首都是哪里' }).click();
		await page.locator('.modal:has-text("题目详情")').waitFor();
		await page.locator('.detail__block--answer .detail__text').waitFor();
		await page.locator('.modal button:has-text("编辑")').click();
		await page.fill('textarea[aria-label="答案"]', '北京（修改）');
		await page.locator('.modal button:has-text("保存")').click();
		await waitModalsClosed();
		await page.locator('.q-row', { hasText: '中国的首都是哪里' }).click();
		await waitText('.detail__block--answer .detail__text', '北京（修改）', 20000);
		await page.locator('.modal button[aria-label="关闭"]').click();
		await waitModalsClosed();
		report('question edited with a full-field PUT');
		await saveShot('question-bank-questions.png');

		// Folders: default folder is protected, non-empty folders are not deleted.
		await page.fill('input[aria-label="搜索题干"]', '');
		await page.locator('button[aria-label="新建文件夹"]').click();
		await page.fill('input[aria-label="文件夹名称"]', 'E2E 文件夹');
		await page.locator('.modal button:has-text("保存")').click();
		await page.locator('.folder-row', { hasText: 'E2E 文件夹' }).waitFor({ timeout: 20000 });
		const defaultRow = page.locator('.folder-row', { hasText: '默认文件夹' });
		assert.equal(await defaultRow.locator('button[aria-label="删除文件夹"]').count(), 0);
		report('folder created and the default folder offers no rename or delete');

		await page.locator('.folder-row', { hasText: 'E2E 文件夹' }).locator('.folder-row__main').click();
		await page.click('button:has-text("新建题目")');
		await page.locator('.modal').waitFor();
		await page.fill('textarea[aria-label="题干"]', '文件夹内的题');
		await page.fill('textarea[aria-label="答案"]', 'A');
		await page.locator('.sw', { hasText: '待修正' }).locator('.sw__track').click();
		await page.locator('.modal button:has-text("保存")').click();
		await page.locator('.q-row', { hasText: '文件夹内的题' }).waitFor({ timeout: 20000 });
		await page.locator('.q-row', { hasText: '文件夹内的题' }).locator('.tag--bad').waitFor({ timeout: 20000 });
		report('pending-correction records are flagged in the list');

		await page.locator('.folder-row', { hasText: 'E2E 文件夹' }).locator('button[aria-label="删除文件夹"]').click();
		await page.locator('.modal button:has-text("删除")').click();
		await page.locator('.toast--error:has-text("先移动或删除内容")').waitFor({ timeout: 20000 });
		report('non-empty folder deletion is refused with FOLDER_NOT_EMPTY');

		await page.locator('.q-row', { hasText: '文件夹内的题' }).locator('button[aria-label="删除题目"]').click();
		await page.locator('.modal button:has-text("删除")').click();
		await page.locator('.q-row', { hasText: '文件夹内的题' }).waitFor({ state: 'detached', timeout: 20000 });
		await page.locator('.folder-row', { hasText: 'E2E 文件夹' }).locator('button[aria-label="删除文件夹"]').click();
		await page.locator('.modal button:has-text("删除")').click();
		await page.locator('.folder-row', { hasText: 'E2E 文件夹' }).waitFor({ state: 'detached', timeout: 20000 });
		report('question and empty folder deleted from the console');

		// JSON import: valid file first, then a file with an invalid record.
		const importFile = path.join(dir, 'questions.json');
		fs.writeFileSync(
			importFile,
			JSON.stringify({
				questions: Array.from({ length: 25 }, (_, index) => ({
					question: `E2E 导入题 ${String(index + 1).padStart(2, '0')}`,
					answer: `答案 ${index + 1}`
				}))
			})
		);
		await openTab('导入');
		await page.setInputFiles('input[aria-label="选择导入文件"]', importFile);
		await page.locator('.preview-cell').nth(1).waitFor({ timeout: 20000 });
		assert.equal((await page.locator('.preview-cell').nth(1).locator('.preview-value').textContent()).trim(), '25');
		await page.locator('.import-foot button:has-text("提交 25 条")').click();
		await page.locator('.run__row .tag--ok').first().waitFor({ timeout: 30000 });
		assert.equal((await page.locator('.run__row').first().textContent()).includes('新增 25'), true);
		report('25 records imported in a single batch');
		await saveShot('question-bank-import.png');

		const invalidFile = path.join(dir, 'invalid.json');
		fs.writeFileSync(invalidFile, JSON.stringify({ questions: [{ question: '缺少答案', answer: '' }] }));
		await page.setInputFiles('input[aria-label="选择导入文件"]', invalidFile);
		await page.locator('.issue-list li').first().waitFor({ timeout: 20000 });
		assert.equal(await page.locator('.import-foot button.btn--primary').isDisabled(), true);
		report('an invalid record blocks submission and lists the row');

		// Pagination reflects the imported records.
		await openTab('题目');
		await page.locator('.pager__count:has-text("/ 2")').waitFor({ timeout: 20000 });
		await page.click('button[aria-label="下一页"]');
		await page.locator('.pager__count:has-text("2 / 2")').waitFor({ timeout: 20000 });
		await page.click('button[aria-label="上一页"]');
		await page.locator('.pager__count:has-text("1 / 2")').waitFor({ timeout: 20000 });
		report('pagination reflects the import and returns to page one');

		// Client issuance discloses the token once.
		await openTab('客户端');
		await page.locator('.clients-layout').waitFor();
		await page.fill('input[aria-label="客户端名称"]', 'E2E 外部浏览器');
		await page.fill('input[aria-label="主服务 Base URL"]', base);
		await page.click('button:has-text("生成配置")');
		await page.locator('.connection-panel').waitFor({ timeout: 20000 });
		const queryToken = (await page.locator('.cred--secret').textContent()).trim();
		assert.match(queryToken, /^[a-f0-9]{64}$/);
		const wrapper = await page.locator('.wrapper__code').textContent();
		assert.equal(wrapper.includes(queryToken), true);
		assert.equal(wrapper.includes('/question-bank/query'), true);
		const storage = await page.evaluate(() => {
			const collected = {};
			for (const store of [localStorage, sessionStorage]) {
				for (let index = 0; index < store.length; index += 1) {
					const key = store.key(index);
					collected[key] = store.getItem(key);
				}
			}
			return JSON.stringify(collected);
		});
		assert.equal(storage.includes(queryToken), false);
		assert.equal(storage.includes(apiKey), false);
		report('connection generated, token shown once and never written to storage');
		await saveShot('question-bank-clients.png');

		// Query probe: local hit, AI fallback, then paused queries.
		const queryRequests = [];
		page.on('request', (request) => {
			if (request.url().includes('/question-bank/query')) queryRequests.push(request.headers());
		});
		await openTab('查询验证');
		await page.locator('.field__action:has-text("用本次令牌")').click();
		assert.equal(await page.locator('input[aria-label="查询令牌"]').inputValue(), queryToken);
		await page.fill('textarea[aria-label="查询题干"]', '中国的首都是哪里');
		await page.fill('textarea[aria-label="查询选项"]', 'A. 北京\nB. 上海');
		await page.click('button:has-text("执行查询")');
		await waitText('.answer__text', '北京（修改）', 40000);
		assert.equal(queryRequests.length, 1);
		assert.equal(queryRequests[0].authorization, 'Bearer ' + queryToken);
		assert.notEqual(queryRequests[0].authorization, 'Bearer ' + token);
		report('query probe hit the local record with only the query token');

		await page.fill('textarea[aria-label="查询题干"]', 'E2E 未收录的问题');
		await page.fill('textarea[aria-label="查询选项"]', '');
		await page.click('button:has-text("执行查询")');
		await waitText('.answer__text', aiAnswer, 60000);
		assert.equal(providerSeen.length > 0, true);
		assert.equal(providerSeen[0].authorization, 'Bearer ' + apiKey);
		report('AI fallback used the configured provider key');
		await saveShot('question-bank-query.png');

		await page.click('.page-head__actions button:has-text("暂停查询")');
		await waitText('.link-line .status', '查询暂停', 20000);
		await page.click('button:has-text("执行查询")');
		await waitText('.outcome__code', 'SERVICE_PAUSED', 30000);
		await page.click('.page-head__actions button:has-text("启用查询")');
		await waitText('.link-line .status', '查询可用', 20000);
		report('paused queries report SERVICE_PAUSED and resume cleanly');

		// Metadata logs distinguish local, AI-origin and failed requests.
		await openTab('日志');
		await page.locator('.logs-panel .row').first().waitFor({ timeout: 20000 });
		const logs = await page.locator('.logs-panel').innerText();
		assert.equal(logs.includes('本地命中'), true);
		assert.equal(logs.includes('AI 记录'), true);
		assert.equal(logs.includes('中国的首都是哪里'), false);
		report('logs list metadata without question bodies');
		await saveShot('question-bank-logs.png');

		// Revocation invalidates the query token without ending the admin session.
		await openTab('客户端');
		await page.locator('.connection-panel button[aria-label="关闭本次结果"]').click();
		await page.locator('.connection-panel').waitFor({ state: 'detached' });
		await page.locator('.client-tools button[aria-label="撤销客户端"]').first().click();
		await page.locator('.modal button:has-text("撤销")').click();
		await page.locator('.row', { hasText: 'E2E 外部浏览器' }).waitFor({ state: 'detached', timeout: 20000 });
		const revoked = await page.evaluate(
			async ({ queryToken: query }) => {
				const response = await fetch('/question-bank/query', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + query },
					body: JSON.stringify({ title: '中国的首都是哪里' })
				});
				return { status: response.status, body: await response.json() };
			},
			{ queryToken }
		);
		assert.equal(revoked.status, 401);
		assert.equal(revoked.body.error.code, 'UNAUTHORIZED');
		assert.equal(await page.locator('.shell').isVisible(), true);
		report('revoked token returns 401 and the admin session survives');

		// The log keeps working and still holds no bodies after the revocation.
		await openTab('日志');
		await page.click('.logs-panel button:has-text("刷新")');
		await page.locator('.logs-panel .row').first().waitFor({ timeout: 20000 });
		assert.equal((await page.locator('.logs-panel').innerText()).includes('不作为'), false);
		assert.equal((await page.locator('.logs-panel .row').count()) > 0, true);
		report('logs stay metadata-only after revocation');

		// Leaving the page clears the in-memory token result.
		await page.click('a.nav-item:has-text("运行态势")');
		await page.locator('h1:has-text("运行态势")').waitFor();
		await page.click('a.nav-item:has-text("题库服务")');
		await page.locator('h1:has-text("题库服务")').waitFor();
		await openTab('客户端');
		await page.locator('.clients-layout').waitFor();
		assert.equal(await page.locator('.connection-panel').count(), 0);
		await openTab('查询验证');
		assert.equal(await page.locator('input[aria-label="查询令牌"]').inputValue(), '');
		report('leaving the page dropped the issued token from memory');

		// The remaining two service states: no deployment config, and an unreachable bank.
		const delayedConnection = await holdFirstReply('**/api/v1/question-bank/connections');
		try {
			await openTab('客户端');
			await page.fill('input[aria-label="客户端名称"]', 'E2E 延迟返回的客户端');
			await page.fill('input[aria-label="主服务 Base URL"]', base);
			await page.click('button:has-text("生成配置")');
			await delayedConnection.arrived;
			await revisitBank();
			await openTab('客户端');
		} finally {
			await delayedConnection.resume();
		}
		assert.equal(await page.locator('.connection-panel').count(), 0);
		report('late connection replies cannot restore credentials after leaving the page');

		const delayedStatus = await holdFirstReply('**/api/v1/question-bank/status', (value) => {
			value.data.enabled = false;
			return value;
		});
		try {
			await page.click('.page-head__actions button:has-text("同步")');
			await delayedStatus.arrived;
			await revisitBank();
		} finally {
			await delayedStatus.resume();
		}
		assert.equal((await page.locator('.link-line .status').textContent()).trim(), '查询可用');
		report('late status replies do not overwrite the new page visit');

		const delayedImport = await holdFirstReply('**/api/v1/question-bank/questions/import');
		try {
			await openTab('导入');
			await page.setInputFiles('input[aria-label="选择导入文件"]', {
				name: 'leave-during-import.json',
				mimeType: 'application/json',
				buffer: Buffer.from(
					JSON.stringify({
						questions: Array.from({ length: 501 }, (_, index) => ({
							question: '离页导入 ' + index,
							answer: 'fixture'
						}))
					})
				)
			});
			await page.locator('.import-foot button:has-text("提交 501 条")').click();
			await delayedImport.arrived;
			await revisitBank();
		} finally {
			await delayedImport.resume();
		}
		assert.equal(delayedImport.requests, 1);
		report('leaving during import prevents subsequent batches from being submitted');

		const other = async (name, env, expected) => {
			const dataDir = path.join(dir, name);
			const saved = {
				url: process.env.OCS_QUESTION_BANK_URL,
				file: process.env.OCS_QUESTION_BANK_TOKEN_FILE
			};
			process.env.OCS_DATA_DIR = dataDir;
			if (env.url === null) delete process.env.OCS_QUESTION_BANK_URL;
			else process.env.OCS_QUESTION_BANK_URL = env.url;
			if (env.file === null) delete process.env.OCS_QUESTION_BANK_TOKEN_FILE;
			else process.env.OCS_QUESTION_BANK_TOKEN_FILE = env.file;
			let extra;
			try {
				const { startServer } = require(serverEntry);
				extra = await startServer();
				const otherBase = 'http://127.0.0.1:' + extra.server.address().port;
				const otherContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
				const otherPage = await otherContext.newPage();
				await otherPage.goto(otherBase + '/', { waitUntil: 'domcontentloaded' });
				await otherPage.locator('.connect__title').waitFor({ timeout: 15000 });
				await otherPage.fill('input[aria-label="管理令牌"]', token);
				await otherPage.click('button:has-text("建立连接")');
				await otherPage.locator('.shell').waitFor({ timeout: 15000 });
				await otherPage.click('a.nav-item:has-text("题库服务")');
				await otherPage.locator('.notice__title', { hasText: expected }).waitFor({ timeout: 20000 });
				assert.equal(await otherPage.locator('.bank-tabs').count(), 0);
				if (shotsDir) {
					fs.mkdirSync(shotsDir, { recursive: true });
					await otherPage.screenshot({ path: path.join(shotsDir, name + '.png'), fullPage: true });
				}
				await otherContext.close();
			} finally {
				await extra?.close().catch(() => {});
				if (saved.url === undefined) delete process.env.OCS_QUESTION_BANK_URL;
				else process.env.OCS_QUESTION_BANK_URL = saved.url;
				if (saved.file === undefined) delete process.env.OCS_QUESTION_BANK_TOKEN_FILE;
				else process.env.OCS_QUESTION_BANK_TOKEN_FILE = saved.file;
				process.env.OCS_DATA_DIR = path.join(dir, 'ocs');
			}
		};
		await other('unconfigured', { url: null, file: null }, '题库服务尚未接入');
		report('unconfigured deployment disables the page instead of offering settings');
		await other('unreachable', { url: 'http://127.0.0.1:1', file: tokenFile }, '无法读取题库状态');
		report('an unreachable question bank surfaces a retryable failure');

		const unexpected = consoleErrors.filter((message) => !message.includes('Failed to load resource'));
		assert.deepEqual(unexpected, [], 'unexpected console errors: ' + unexpected.join(' | '));
		console.log('\nQuestion bank end-to-end checks passed.');
	} catch (error) {
		if (page) {
			const screenshot = path.join(packageRoot, 'test-results', 'question-bank-failure.png');
			fs.mkdirSync(path.dirname(screenshot), { recursive: true });
			await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
			console.error('\nQuestion bank failure screenshot: ' + screenshot);
		}
		throw error;
	} finally {
		clearTimeout(hardStop);
		await browser?.close().catch(() => {});
		await service?.close().catch(() => {});
		await bank?.close().catch(() => {});
		if (provider) await new Promise((resolve) => provider.server.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
