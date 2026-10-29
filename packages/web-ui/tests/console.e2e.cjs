/**
 * Real-browser console regression.
 *
 * Requires the built backend and console:
 *   pnpm build && pnpm build:web
 * Then:
 *   pnpm test:web
 *
 * Set OCS_E2E_BROWSER to an installed Chromium/Edge executable when the
 * Playwright browser download is unavailable. The same path is passed to the
 * backend worker so instance startup uses the same binary.
 * Set OCS_E2E_SHOTS to a directory to save screenshots at key steps.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const packageRoot = path.join(__dirname, '..');
const repoRoot = path.join(packageRoot, '..', '..');
const serverEntry = path.join(repoRoot, 'packages', 'server', 'dist', 'index.js');
const webIndex = path.join(repoRoot, 'packages', 'server', 'web', 'index.html');
const token = 'web-console-e2e-token-1234567890abcdef';
const browserPath = process.env.OCS_E2E_BROWSER || '';
const shotsDir = process.env.OCS_E2E_SHOTS || '';

for (const [file, hint] of [
	[serverEntry, 'pnpm build'],
	[webIndex, 'pnpm build:web']
]) {
	if (!fs.existsSync(file)) throw new Error('Missing ' + file + '; run ' + hint + ' first');
}

function pageHtml(title, body) {
	return (
		'<!doctype html><html><head><meta charset="utf-8"><title>' +
		title +
		'</title>' +
		'<style>body{margin:0;padding:48px;font:15px/1.6 system-ui,sans-serif;background:#eef2f7;color:#16202c}' +
		'h1{font-size:34px;margin:0 0 24px}input,button{font:inherit;padding:8px 12px;margin-right:8px}' +
		'p{min-height:24px}a{margin-right:16px}</style></head><body>' +
		body +
		'</body></html>'
	);
}

function startFixture() {
	const server = http.createServer((request, response) => {
		if (request.url === '/second') {
			response.setHeader('Content-Type', 'text/html');
			response.end(pageHtml('Fixture Second', '<h1 id="title">Second page</h1><a id="back" href="/">back</a>'));
			return;
		}
		if (request.url === '/file.txt') {
			response.setHeader('Content-Type', 'text/plain');
			response.end('fixture download content\n');
			return;
		}
		response.setHeader('Content-Type', 'text/html');
		response.end(
			pageHtml(
				'Fixture Home',
				'<h1 id="title">Fixture Home</h1>' +
					'<input id="name" placeholder="name" />' +
					"<button id=\"greet\" onclick=\"document.getElementById('out').textContent = 'hello ' + document.getElementById('name').value\">Greet</button>" +
					'<p id="out"></p>' +
					'<a id="dl" href="/file.txt" download="fixture.txt">download file</a>' +
					'<a id="second" href="/second">second page</a>'
			)
		);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Serve the console and proxy API requests with a foreign Origin header. */
function startOriginProxy(backendPort) {
	const staticRoot = path.join(repoRoot, 'packages', 'server', 'web');
	const types = {
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript',
		'.css': 'text/css',
		'.svg': 'image/svg+xml'
	};
	const server = http.createServer((request, response) => {
		if (request.url.startsWith('/api/')) {
			const headers = { ...request.headers, host: '127.0.0.1:' + backendPort, origin: 'https://console.example' };
			const upstream = http.request(
				{ host: '127.0.0.1', port: backendPort, path: request.url, method: request.method, headers },
				(res) => {
					response.writeHead(res.statusCode || 502, res.headers);
					res.pipe(response);
				}
			);
			upstream.on('error', () => {
				response.statusCode = 502;
				response.end('proxy error');
			});
			request.pipe(upstream);
			return;
		}
		const file = request.url === '/' ? 'index.html' : request.url.split('?')[0].replace(/^\//, '');
		const resolved = path.join(staticRoot, file);
		if (!resolved.startsWith(staticRoot) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
			response.statusCode = 404;
			response.end('not found');
			return;
		}
		response.setHeader('Content-Type', types[path.extname(resolved)] || 'application/octet-stream');
		fs.createReadStream(resolved).pipe(response);
	});
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
	// Bound the suite if browser operations stall despite normal cleanup.
	const hardStop = setTimeout(() => {
		console.error('Web console e2e exceeded the 5 minute limit.');
		process.exit(1);
	}, 5 * 60 * 1000);
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-web-e2e-'));
	process.env.OCS_DATA_DIR = dataDir;
	process.env.OCS_AUTH_TOKEN = token;
	process.env.OCS_PORT = '0';
	process.env.OCS_HOST = '127.0.0.1';
	process.env.OCS_MAX_BROWSERS = '2';
	if (browserPath) process.env.OCS_BROWSER_EXECUTABLE_PATH = browserPath;

	let service;
	let fixture;
	let browser;
	let page;
	try {
		const { startServer } = require(serverEntry);
		service = await startServer();
		const backendPort = service.server.address().port;
		const base = 'http://127.0.0.1:' + backendPort;

		fixture = await startFixture();
		const fixtureBase = 'http://127.0.0.1:' + fixture.address().port;
		browser = await chromium.launch({
			// Match browser:install --no-shell and the server worker's full Chromium.
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			...(browserPath ? { executablePath: browserPath } : {})
		});
		const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
		page = await context.newPage();
		const consoleErrors = [];
		page.on('console', (message) => {
			if (message.type() === 'error') consoleErrors.push(message.text());
		});
		page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message));

		const report = (message) => console.log('  ✓ ' + message);
		const saveShot = async (name) => {
			if (!shotsDir) return;
			fs.mkdirSync(shotsDir, { recursive: true });
			for (const button of await page.locator('.toast__close').all()) {
				await button.click({ timeout: 500 }).catch(() => {});
			}
			await page.evaluate(() => window.scrollTo(0, 0));
			await page.waitForTimeout(250);
			await page.screenshot({ path: path.join(shotsDir, name) });
		};
		const waitForIdle = async () => {
			await page.waitForFunction(() => !document.querySelector('.ops button[disabled]'), null, { timeout: 30000 });
		};
		const runAction = async (action, trigger) => {
			await Promise.all([
				page.waitForResponse(
					(response) => response.url().endsWith('/' + action) && response.request().method() === 'POST'
				),
				trigger()
			]);
			await waitForIdle();
		};
		const waitText = async (selector, text, timeout = 15000) => {
			await page.waitForFunction(
				({ selector, text }) => {
					const element = document.querySelector(selector);
					return !!element && (element.textContent || '').includes(text);
				},
				{ selector, text },
				{ timeout }
			);
		};

		// Authentication, session-only storage and manual re-authentication.
		await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
		await page.locator('.connect__title').waitFor({ timeout: 15000 });
		await page.fill('input[aria-label="管理令牌"]', 'wrong-' + token);
		await page.click('button:has-text("建立连接")');
		await waitText('.inline-error', '令牌无效');
		report('invalid token shows a localised error');
		await page.fill('input[aria-label="管理令牌"]', token);
		await page.click('button:has-text("建立连接")');
		await page.locator('.shell').waitFor({ timeout: 15000 });
		await waitText('.link-state', '实时连接', 20000);
		const storage = await page.evaluate(() => ({
			session: sessionStorage.getItem('ocs.console.token'),
			local: localStorage.getItem('ocs.console.token')
		}));
		assert.equal(storage.session, token);
		assert.equal(storage.local, null);
		report('authenticated and kept the token session-only');

		// SSE interruption, backoff and recovery.
		await page.click('a.nav-item:has-text("事件")');
		await page.locator('h1:has-text("事件流")').waitFor();
		await page.route('**/api/v1/events', (route) => route.abort());
		await page.click('button:has-text("暂停订阅")');
		await waitText('.tag', '已暂停');
		await page.click('button:has-text("恢复订阅")');
		await waitText('.tag', '重连中', 15000);
		await page.unroute('**/api/v1/events');
		await waitText('.tag', '实时连接', 30000);
		report('event stream retried and recovered');

		// User scripts are ordinary page JavaScript with URL wildcard matching.
		await page.click('a.nav-item:has-text("用户脚本")');
		await page.locator('h1:has-text("用户脚本")').waitFor();
		await page.click('button:has-text("新建脚本")');
		await page.fill('input[placeholder="例如：教务系统自动跳转"]', 'E2E 示例脚本');
		await page.fill('textarea[placeholder^="https://example.com/*"]', fixtureBase + '/*');
		await page.fill('textarea[placeholder^="// 普通 JavaScript"]', "document.documentElement.dataset.e2e = '1';");
		await page.click('button:has-text("保存脚本")');
		await page.locator('.script-item', { hasText: 'E2E 示例脚本' }).waitFor({ timeout: 15000 });
		report('user script created from the console');
		await page.click('a.nav-item:has-text("实例")');

		// Conditional automation fields follow the shared definitions.
		await page.click('button:has-text("新建实例")');
		await page.locator('.modal').waitFor();
		await page.fill('input[placeholder="例如：教务系统 A"]', '本地 Fixture');
		await page.fill('input[placeholder="https://example.com"]', fixtureBase + '/');
		await page.selectOption('.auto-add select', { label: '超星-自动登录' });
		await page.click('button:has-text("添加")');
		const cxBlock = page.locator('.auto-block').filter({ hasText: '超星-自动登录' });
		await cxBlock.getByRole('note').filter({ hasText: '当前服务未提供 OCR' }).waitFor();
		await cxBlock.waitFor();
		assert.equal(await cxBlock.locator('.field__label', { hasText: '手机号' }).count(), 1);
		assert.equal(await cxBlock.locator('.field__label', { hasText: '学校/单位' }).count(), 0);
		await cxBlock.locator('select').selectOption({ label: '学校机构登录' });
		await cxBlock.locator('.field__label', { hasText: '学校/单位' }).waitFor();
		assert.equal(await cxBlock.locator('.field__label', { hasText: '学号/工号' }).count(), 1);
		assert.equal(await cxBlock.locator('.field__label', { hasText: '手机号' }).count(), 0);
		report('visibleWhen fields switched with the select');
		await cxBlock.locator('button[title="移除"]').click();
		await page.selectOption('.auto-add select', { label: '通用-新建页面' });
		await page.click('button:has-text("添加")');
		assert.equal(await page.locator('.auto-block').getByRole('note').count(), 0);
		await page.fill('.auto-block input[placeholder^="请输入网页链接"]', fixtureBase + '/second');
		await page.click('.modal__foot button:has-text("创建实例")');
		await page.locator('.tabs').waitFor({ timeout: 15000 });
		report('instance created from generated fields');

		// Real headless browser lifecycle, pages, screenshot and actions.
		await page.click('.page-head__actions button:has-text("启动")');
		await page.locator('.status--running').waitFor({ timeout: 90000 });
		await page.locator('.page-item').first().waitFor({ timeout: 30000 });
		await page.waitForFunction(
			() => {
				const image = document.querySelector('.shot img');
				return !!image && image.naturalWidth > 0;
			},
			null,
			{ timeout: 30000 }
		);
		report('browser started and screenshot rendered');
		await saveShot('console-pages.png');

		const ops = page.locator('.ops');
		await ops.locator('input[placeholder="input[name=username]"]').fill('#name');
		await ops.locator('input[placeholder="临时输入值"]').fill('Ada');
		await runAction('fill', () => ops.locator('button:has-text("填充")').click());
		await waitText('.toast', '已填入字段', 20000);
		await ops.locator('input[placeholder="button[type=submit]"]').fill('#greet');
		await runAction('click', () => ops.locator('button:has-text("点击")').click());
		await page.waitForTimeout(800);
		assert.equal(await page.locator('.ops .inline-error').count(), 0);
		report('fill and click actions succeeded');

		await ops.locator('input[placeholder="https://example.com"]').fill(fixtureBase + '/second');
		await runAction('navigate', () => ops.locator('button:has-text("前往")').click());
		await page.waitForFunction(
			(expected) => document.querySelector('.page-item.is-active .page-item__url')?.textContent === expected,
			fixtureBase + '/second',
			{ timeout: 20000 }
		);
		report('navigation refreshed the page list');
		await ops.locator('input[placeholder="https://example.com"]').fill(fixtureBase + '/');
		await runAction('navigate', () => ops.locator('button:has-text("前往")').click());
		await page.waitForFunction(
			(expected) => document.querySelector('.page-item.is-active .page-item__url')?.textContent === expected,
			fixtureBase + '/',
			{ timeout: 20000 }
		);

		// Downloads triggered by page content and fetched with the bearer token.
		await ops.locator('input[placeholder="button[type=submit]"]').fill('#dl');
		await runAction('click', () => ops.locator('button:has-text("点击")').click());
		await page.waitForTimeout(800);
		await page.click('button.tab:has-text("下载")');
		await page.locator('.download-row').first().waitFor({ timeout: 20000 });
		const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
		await page.locator('.download-row button:has-text("下载")').first().click();
		const download = await downloadPromise;
		assert.equal(download.suggestedFilename(), 'fixture.txt');
		report('download listed and fetched through the console');

		await page.click('button.tab:has-text("自动化")');
		await page.locator('.tag--ok', { hasText: '已完成' }).waitFor({ timeout: 30000 });
		await page.locator('.automation-log .event-row').first().waitFor({ timeout: 10000 });
		assert.ok((await page.locator('.automation-log .event-row').count()) >= 2);
		report('automation result shown with recent runs');
		await saveShot('console-automation.png');

		// Restart and stop must reset run-scoped page state. The restart HTTP
		// response resolves after the new browser is ready, so wait for it.
		const restartResponse = page.waitForResponse(
			(response) => response.url().endsWith('/restart') && response.request().method() === 'POST',
			{ timeout: 90000 }
		);
		await page.click('.page-head__actions button:has-text("重启")');
		await restartResponse;
		await page.locator('.status--running').waitFor({ timeout: 90000 });
		await page.click('button.tab:has-text("页面")');
		await page.locator('.page-item').first().waitFor({ timeout: 30000 });
		report('restart returned to a live page list');
		await page.click('.page-head__actions button:has-text("停止")');
		await page.locator('.status--stopped').waitFor({ timeout: 30000 });
		await page.locator('.offline-shot').waitFor();
		report('stop cleared run-scoped pages');

		await page.click('button.tab:has-text("事件")');
		await page.locator('.event-row').first().waitFor();
		await page.locator('.event-row').first().click();
		await page.locator('.event-row__raw').first().waitFor();
		report('event details expand inline');

		// settings.ocs is a whole-object replacement.
		await page.click('a.nav-item:has-text("平台设置")');
		await page.locator('.json-editor').waitFor();
		await page.fill('.json-editor', JSON.stringify({ e2e: true, refreshedAt: '2026-10-24' }, null, 2));
		await page.click('button:has-text("保存")');
		await page.locator('.toast:has-text("平台设置已保存")').waitFor({ timeout: 15000 });
		report('settings.ocs replaced as a whole object');

		// Logout clears storage; a foreign Origin surfaces the deployment hint.
		await page.click('.rail__logout');
		await page.locator('.connect__title').waitFor();
		const cleared = await page.evaluate(() => ({
			session: sessionStorage.getItem('ocs.console.token'),
			local: localStorage.getItem('ocs.console.token')
		}));
		assert.deepEqual(cleared, { session: null, local: null });
		report('logout cleared credentials');

		// Opt-in persistence must use localStorage and be cleared by logout too.
		await page.locator('.sw__track').click();
		await page.fill('input[aria-label="管理令牌"]', token);
		await page.click('button:has-text("建立连接")');
		await page.locator('.shell').waitFor({ timeout: 15000 });
		const remembered = await page.evaluate(() => ({
			session: sessionStorage.getItem('ocs.console.token'),
			local: localStorage.getItem('ocs.console.token')
		}));
		assert.deepEqual(remembered, { session: null, local: token });
		await page.click('.rail__logout');
		await page.locator('.connect__title').waitFor();
		assert.deepEqual(
			await page.evaluate(() => ({
				session: sessionStorage.getItem('ocs.console.token'),
				local: localStorage.getItem('ocs.console.token')
			})),
			{ session: null, local: null }
		);
		report('remembered token uses localStorage and logout clears it');

		const proxy = await startOriginProxy(backendPort);
		try {
			await page.goto('http://127.0.0.1:' + proxy.address().port + '/', { waitUntil: 'domcontentloaded' });
			await page.fill('input[aria-label="管理令牌"]', token);
			await page.click('button:has-text("建立连接")');
			await waitText('.inline-error', 'OCS_ALLOWED_ORIGINS', 15000);
			report('origin rejection explains OCS_ALLOWED_ORIGINS');
		} finally {
			await new Promise((resolve) => proxy.close(resolve));
		}

		const unexpected = consoleErrors.filter(
			(message) => !message.includes('403') && !message.includes('Failed to load resource')
		);
		assert.deepEqual(unexpected, [], 'unexpected console errors: ' + unexpected.join(' | '));
		console.log('\nWeb console end-to-end checks passed.');
	} catch (error) {
		if (page) {
			const screenshot = path.join(packageRoot, 'test-results', 'console-failure.png');
			fs.mkdirSync(path.dirname(screenshot), { recursive: true });
			await page.screenshot({ path: screenshot, fullPage: true }).catch(() => {});
			console.error('\nConsole failure screenshot: ' + screenshot);
		}
		throw error;
	} finally {
		clearTimeout(hardStop);
		await browser?.close().catch(() => {});
		await service?.close();
		if (fixture) await new Promise((resolve) => fixture.close(resolve));
		fs.rmSync(dataDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
