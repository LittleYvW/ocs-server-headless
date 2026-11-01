const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { startServer } = require('../dist/index.js');
const { loadConfig } = require('../dist/config.js');

const binary =
	process.env.ZERROR_TEST_BINARY ||
	path.resolve(
		process.env.CARGO_TARGET_DIR || path.resolve(__dirname, '../../../services/zerror/target'),
		'debug',
		'zerror-headless'
	);

async function startBank(dir) {
	const child = spawn(binary, [], {
		env: {
			...process.env,
			ZERROR_DATA_DIR: dir,
			ZERROR_HOST: '127.0.0.1',
			ZERROR_PORT: '0',
			ZERROR_ADMIN_TOKEN_FILE: path.join(dir, 'admin.token')
		},
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	const base = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error('Question bank startup timed out: ' + output));
		}, 15000);
		child.once('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once('exit', () => {
			clearTimeout(timer);
			reject(new Error('Question bank exited during startup: ' + output));
		});
		child.stderr.on('data', (data) => {
			output += data;
		});
		child.stdout.on('data', (data) => {
			output += data;
			const found = output.match(/listening on (127\.0\.0\.1:\d+)/);
			if (found) {
				clearTimeout(timer);
				resolve('http://' + found[1]);
			}
		});
	});
	return {
		base,
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

test('standalone Rust question bank through the OCS gateway', { timeout: 90000 }, async (t) => {
	assert(fs.existsSync(binary), 'Build services/zerror first, or set ZERROR_TEST_BINARY');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-question-bank-'));
	const bankDir = path.join(dir, 'bank');
	fs.mkdirSync(bankDir);
	let bank, ocs;
	let modelCalls = 0;
	let mode = 'answer';
	let matchedId;
	let failures = 0;
	const apiKey = 'provider-secret-never-in-logs';
	const provider = http.createServer(async (req, res) => {
		let text = '';
		for await (const chunk of req) text += chunk;
		const input = JSON.parse(text);
		assert.equal(req.headers.authorization, 'Bearer ' + apiKey);
		assert.equal(input.store, false);
		modelCalls++;
		if (mode === 'retry' && failures++ === 0) {
			res.writeHead(500);
			res.end('private provider details');
			return;
		}
		if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 6000));
		else if (mode === 'cancel') await new Promise((resolve) => setTimeout(resolve, 600));
		else await new Promise((resolve) => setTimeout(resolve, 100));
		if (res.destroyed) return;
		const prompt = input.input || input.messages[0].content;
		const result = prompt.startsWith('判断题目')
			? JSON.stringify({ same: true, matched_id: matchedId })
			: mode === 'bad'
			? 'provider error without a structured answer'
			: JSON.stringify({ answer: 'A' });
		res.setHeader('Content-Type', 'application/json');
		res.end(
			JSON.stringify(
				req.url.endsWith('/responses')
					? {
							output: [
								{ type: 'reasoning', summary: [] },
								{ type: 'message', content: [{ type: 'output_text', text: result }] }
							]
					  }
					: { choices: [{ message: { content: result } }] }
			)
		);
	});
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const modelBase = 'http://127.0.0.1:' + provider.address().port + '/v1';
	const managementToken = 'main-admin-token-'.repeat(4);
	let base, connection, queryToken;
	const managementHeaders = { Authorization: 'Bearer ' + managementToken, 'Content-Type': 'application/json' };
	const admin = async (route, method = 'GET', body) => {
		const response = await fetch(base + '/api/v1/question-bank' + route, {
			method,
			headers: managementHeaders,
			body: body === undefined ? undefined : JSON.stringify(body)
		});
		return { status: response.status, json: await response.json() };
	};
	const query = async (input, token = queryToken, method = 'POST') => {
		const url = base + '/question-bank/query' + (method === 'GET' ? '?' + new URLSearchParams(input) : '');
		const response = await fetch(url, {
			method,
			headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
			body: method === 'GET' ? undefined : JSON.stringify(input)
		});
		return { status: response.status, json: await response.json() };
	};
	try {
		bank = await startBank(bankDir);
		const makeOCS = async () => {
			ocs = await startServer(
				loadConfig({
					OCS_DATA_DIR: path.join(dir, 'ocs'),
					OCS_AUTH_TOKEN: managementToken,
					OCS_PORT: '0',
					OCS_QUESTION_BANK_URL: bank.base,
					OCS_QUESTION_BANK_TOKEN_FILE: path.join(bankDir, 'admin.token')
				})
			);
			base = 'http://127.0.0.1:' + ocs.server.address().port;
		};
		await makeOCS();
		await t.test('separates administrator, query and internal credentials', async () => {
			assert.equal((await fetch(base + '/api/v1/question-bank/status')).status, 401);
			assert.equal(
				(
					await fetch(base + '/api/v1/question-bank/status', {
						headers: { ...managementHeaders, Origin: 'https://foreign.test' }
					})
				).status,
				403
			);
			assert.equal((await query({ title: 'x' }, managementToken)).status, 401);
			assert.equal((await admin('/status')).json.data.available, true);
			assert.equal((await fetch(base + '/healthz')).status, 200);
			assert.equal((await admin('/../../system')).status, 404);
			const internal = fs.readFileSync(path.join(bankDir, 'admin.token'), 'utf8');
			assert.equal((await query({ title: 'x' }, internal)).status, 401);
			assert.equal(
				(
					await fetch(bank.base + '/admin/status', {
						headers: { Authorization: 'Bearer ' + internal, Origin: 'https://foreign.test' }
					})
				).status,
				401
			);
			assert.equal(
				(await fetch(base + '/question-bank/query', { method: 'OPTIONS', headers: { Origin: 'https://course.test' } }))
					.status,
				204
			);
		});
		await t.test('generates an existing OCS wrapper with a separately revocable query token', async () => {
			connection = await admin('/connections', 'POST', { name: 'external browser', baseUrl: base });
			assert.equal(connection.status, 201);
			connection = connection.json.data;
			queryToken = connection.client.token;
			assert.equal(connection.wrapper[0].url, base + '/question-bank/query');
			assert.equal(connection.wrapper[0].type, 'GM_xmlhttpRequest');
			assert.equal(connection.wrapper[0].headers.Authorization, 'Bearer ' + queryToken);
			assert.equal(
				(await fetch(base + '/api/v1/question-bank/status', { headers: { Authorization: 'Bearer ' + queryToken } }))
					.status,
				401
			);
			assert.equal(JSON.stringify((await admin('/tokens')).json).includes(queryToken), false);
		});
		let folderId;
		await t.test('manages a local bank and preserves option-aware lookup and OCS response shape', async () => {
			const folder = await admin('/folders', 'POST', { name: 'Imported questions' });
			folderId = folder.json.data.id;
			assert.equal(folder.status, 200);
			const created = await admin('/questions', 'POST', {
				question: '中国首都是哪里',
				options: 'A. 北京\nB. 上海',
				answer: 'A. 北京',
				folderId
			});
			assert.equal(created.status, 200);
			const answer = await query(
				{ title: '中国首都是哪里', options: 'A. 北京\nB. 上海', type: 'single' },
				queryToken,
				'GET'
			);
			assert.equal(answer.status, 200);
			assert.equal(answer.json.code, 1);
			assert.equal(answer.json.data.answer, '北京');
			assert.equal(Array.isArray(answer.json.data), false);
			assert.equal(answer.json.data.is_ai, false);
			const handle = Function(connection.wrapper[0].handler)();
			assert.deepEqual(handle(answer.json), ['中国首都是哪里', '北京', { ai: false }]);
			assert.equal((await query({ title: '中国首都是哪里', options: 'A. 广州\nB. 深圳' })).status, 404);
			assert.equal((await admin('/folders/' + folderId, 'DELETE')).status, 409);
			assert.equal((await admin('/folders/' + folderId, 'PUT', { name: 'cycle', parentId: folderId })).status, 400);
			await admin('/questions/' + created.json.data.id, 'PUT', {
				question: '中国首都是哪里',
				options: 'A. 北京\nB. 上海',
				answer: '北京',
				isPendingCorrection: true,
				folderId
			});
			assert.equal((await query({ title: '中国首都是哪里', options: 'A. 北京\nB. 上海' })).status, 404);
		});
		await t.test('imports atomically, rejects executable settings and encrypts provider credentials', async () => {
			const before = (await admin('/questions')).json.data.total;
			assert.equal(
				(
					await admin('/questions/import', 'POST', {
						questions: [
							{ question: 'rollback marker', answer: 'x' },
							{ question: 'bad folder', answer: 'x', folderId: 999999 }
						]
					})
				).status,
				400
			);
			assert.equal((await admin('/questions')).json.data.total, before);
			const imported = await admin('/questions/import', 'POST', {
				questions: [
					{ question: '韩国的首都在哪里', answer: '首尔' },
					{ question: '中国的首都在哪里', answer: '北京' }
				]
			});
			assert.equal(imported.json.data.inserted, 2);
			matchedId = (await admin('/questions?q=' + encodeURIComponent('韩国'))).json.data.items[0].id;
			assert.equal((await admin('/settings', 'PATCH', { model: { jsCode: 'process.exit()' } })).status, 400);
			assert.equal((await admin('/settings', 'PATCH', { model: { baseUrl: 'file:///etc/passwd' } })).status, 400);
			const configured = await admin('/settings', 'PATCH', {
				aiEnabled: true,
				sameQuestionCheck: false,
				model: { baseUrl: modelBase, modelId: 'fixture-model', apiKey }
			});
			assert.equal(configured.status, 200);
			assert.equal(configured.json.data.model.apiKey, '***');
			assert.equal(fs.readFileSync(path.join(bankDir, 'settings.enc'), 'utf8').includes(apiKey), false);
		});
		const arithmetic = { title: '二加二等于多少', options: 'A. 4\nB. 5', type: 'single' };
		await t.test('runs AI without a frontend, coalesces requests and persists normalized answers', async () => {
			const before = modelCalls;
			const [one, two] = await Promise.all([query(arithmetic), query(arithmetic)]);
			assert.equal(one.status, 200);
			assert.equal(two.status, 200);
			assert.equal(modelCalls - before, 1);
			assert.equal(one.json.data.answer, '4');
			assert.equal(one.json.data.is_ai, true);
			assert.equal(one.json.data.id, two.json.data.id);
			assert.equal((await query(arithmetic)).status, 200);
			assert.equal(modelCalls - before, 1);
		});
		await t.test('cleans up disconnected requests without releasing their running job permits early', async () => {
			mode = 'cancel';
			const before = modelCalls;
			const controllers = [new AbortController(), new AbortController()];
			const requests = controllers.map((controller, index) =>
				fetch(base + '/question-bank/query', {
					method: 'POST',
					headers: connection.wrapper[0].headers,
					body: JSON.stringify({ title: '客户端断开场景' + index, options: 'A. 4\nB. 5' }),
					signal: controller.signal
				}).catch(() => undefined)
			);
			const deadline = Date.now() + 3000;
			while (modelCalls < before + 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(modelCalls, before + 2);
			controllers.forEach((controller) => controller.abort());
			await Promise.all(requests);
			assert.equal((await query({ title: '第三个并发请求' })).status, 429);
			await new Promise((resolve) => setTimeout(resolve, 700));
			assert.equal((await query({ title: '客户端断开场景0', options: 'A. 4\nB. 5' })).json.data.answer, '4');
			assert.equal(modelCalls, before + 2);
			mode = 'answer';
		});
		await t.test('uses AI to judge candidates and supports the Responses wire format', async () => {
			await admin('/settings', 'PATCH', {
				sameQuestionCheck: true,
				model: { protocol: 'openai-response', apiKey: '***' }
			});
			const before = modelCalls;
			const answer = await query({ title: '韩国首都是哪里' });
			assert.equal(answer.status, 200);
			assert.equal(answer.json.data.answer, '首尔');
			assert.equal(modelCalls - before, 1);
			await admin('/settings', 'PATCH', { sameQuestionCheck: false });
			assert.equal((await query({ title: 'Responses 模型协议测试', options: 'A. 4\nB. 5' })).json.data.answer, '4');
		});
		await t.test(
			'retries transient errors, rejects malformed model answers and enforces one total timeout',
			async () => {
				mode = 'retry';
				failures = 0;
				const before = modelCalls;
				assert.equal((await query({ title: '重试场景', options: 'A. 4\nB. 5' })).status, 200);
				assert.equal(modelCalls - before, 2);
				mode = 'bad';
				assert.equal((await query({ title: '异常模型响应场景' })).status, 502);
				assert.equal((await admin('/questions?q=' + encodeURIComponent('异常模型响应场景'))).json.data.total, 0);
				mode = 'slow';
				await admin('/settings', 'PATCH', { timeoutSeconds: 5 });
				const started = Date.now();
				const answer = await query({ title: '超时场景' });
				assert.equal(answer.status, 504);
				assert(Date.now() - started < 5800);
				mode = 'answer';
				await admin('/settings', 'PATCH', { timeoutSeconds: 50 });
			}
		);
		await t.test('applies per-client limits and pauses without stopping administration', async () => {
			const limited = (await admin('/tokens', 'POST', { name: 'rate-limit fixture' })).json.data.token;
			for (let index = 0; index < 60; index++) assert.equal((await query(arithmetic, limited)).status, 200);
			assert.equal((await query(arithmetic, limited)).status, 429);
			await admin('/settings', 'PATCH', { enabled: false });
			assert.equal((await query(arithmetic)).status, 503);
			assert.equal((await admin('/status')).json.data.enabled, false);
			await admin('/settings', 'PATCH', { enabled: true });
			const logs = JSON.stringify((await admin('/logs')).json);
			for (const secret of [apiKey, queryToken, managementToken, 'private provider details', arithmetic.title])
				assert.equal(logs.includes(secret), false);
			assert.equal(ocs.runtime.list().length, 0);
		});
		await t.test('retains settings, tokens and cache across restart; sidecar outages leave OCS healthy', async () => {
			await bank.close();
			assert.equal((await query(arithmetic)).status, 503);
			assert.equal((await fetch(base + '/healthz')).status, 200);
			await ocs.close();
			bank = await startBank(bankDir);
			await makeOCS();
			assert.equal((await admin('/settings')).json.data.model.apiKey, '***');
			const before = modelCalls;
			assert.equal((await query(arithmetic)).json.data.answer, '4');
			assert.equal(modelCalls, before);
			assert.equal((await admin('/tokens/' + connection.client.id, 'DELETE')).status, 200);
			assert.equal((await query(arithmetic)).status, 401);
		});
	} finally {
		await ocs?.close();
		await bank?.close();
		provider.closeAllConnections();
		await new Promise((resolve) => provider.close(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
