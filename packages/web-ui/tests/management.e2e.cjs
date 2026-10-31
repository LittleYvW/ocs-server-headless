/** Real-browser coverage for portable configuration and managed storage. Build server + web first. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { startServer } = require('../../server/dist/index.js');
const { loadConfig } = require('../../server/dist/config.js');

async function main() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-management-e2e-'));
	const token = 'management-fixture-token-1234567890abcdef';
	const shots = path.join(__dirname, '..', 'test-results', 'management');
	let service;
	let browser;
	let fixture;
	const hardStop = setTimeout(() => {
		console.error('Management e2e exceeded 90 seconds');
		process.exit(1);
	}, 90000);
	try {
		service = await startServer(loadConfig({ OCS_DATA_DIR: directory, OCS_AUTH_TOKEN: token, OCS_PORT: '0' }));
		const base = `http://127.0.0.1:${service.server.address().port}`;
		const request = async (route, method = 'GET', body) => {
			const response = await fetch(base + '/api/v1' + route, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			assert.equal(response.ok, true, `API ${route}: ${response.status}`);
			return response.status === 204 ? undefined : (await response.json()).data;
		};
		const profile = await request('/browsers', 'POST', {
			name: 'Migration fixture',
			automationScripts: [
				{ name: '职教云-自动账号密码登录', configs: { username: 'fixture', password: 'never-visible-credential' } }
			]
		});
		const cache = path.join(directory, 'profiles', profile.id, 'Default', 'Cache');
		fs.mkdirSync(cache, { recursive: true });
		fs.writeFileSync(path.join(cache, 'fixture'), 'cache');
		const cookie = path.join(directory, 'profiles', profile.id, 'Default', 'Cookies');
		fs.writeFileSync(cookie, 'cookie');
		browser = await chromium.launch({
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			...(process.env.OCS_E2E_BROWSER ? { executablePath: process.env.OCS_E2E_BROWSER } : {})
		});
		const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(base);
		await page.getByLabel('管理令牌').fill(token);
		await page.getByRole('button', { name: '建立连接' }).click();
		await page.locator('.shell').waitFor();
		await page.locator('.host-panel').waitFor();
		assert.match(await page.locator('.host-panel').innerText(), /可用内存/);
		fs.mkdirSync(shots, { recursive: true });
		await page.screenshot({ path: path.join(shots, 'overview.png'), fullPage: true });
		await page.goto(`${base}/#/settings`);
		await page.locator('.transfer-panel').waitFor();
		assert.equal(await page.getByRole('button', { name: '下载加密配置' }).isDisabled(), true);
		await page.getByLabel('导出密码', { exact: true }).fill('fixture-portable-password');
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: '下载加密配置' }).click();
		const download = await downloadPromise;
		const exported = fs.readFileSync(await download.path());
		assert.equal(exported.includes('never-visible-credential'), false);
		assert.equal(JSON.parse(exported).format, 'ocs-server-headless');
		assert.equal(await page.getByLabel('导出密码', { exact: true }).inputValue(), '');
		await request('/browsers/' + profile.id, 'DELETE');
		await page
			.getByLabel('导入配置文件')
			.setInputFiles({ name: 'restore.ocsdata', mimeType: 'application/json', buffer: exported });
		await page.getByLabel('原导出密码').fill('fixture-portable-password');
		await page.getByRole('button', { name: '查看并确认导入' }).click();
		await page.getByRole('dialog').waitFor();
		assert.match(await page.getByRole('dialog').innerText(), /restore\.ocsdata/);
		await page.getByRole('button', { name: '替换并导入' }).click();
		await page.getByText('已导入 1 个实例、0 个用户脚本。', { exact: true }).waitFor();
		await page.getByRole('dialog').waitFor({ state: 'hidden' });
		assert.equal(service.store.read().browsers[0].automationScripts[0].configs.password, 'never-visible-credential');
		await page.screenshot({ path: path.join(shots, 'settings.png'), fullPage: true });
		await page.goto(`${base}/#/instances/${profile.id}`);
		await page.getByRole('tab', { name: '存储' }).click();
		await page.locator('.storage-metrics').waitFor();
		assert.match(await page.locator('.storage-metrics').innerText(), /11 B/);
		await page.screenshot({ path: path.join(shots, 'storage.png'), fullPage: true });
		await page.getByRole('button', { name: '清理所选内容' }).click();
		await page.getByRole('dialog').waitFor();
		assert.match(await page.getByRole('dialog').innerText(), /保留 Cookie/);
		await page.getByRole('button', { name: '确认清理', exact: true }).click();
		await page.getByRole('dialog').waitFor({ state: 'hidden' });
		assert.equal(fs.existsSync(cache), false);
		assert.equal(fs.readFileSync(cookie, 'utf8'), 'cookie');
		fixture = http.createServer((_req, res) => {
			res.setHeader('Content-Type', 'text/html');
			res.end(
				'<!doctype html><html><body><h1>Local live preview</h1><p id="clock"></p><script>setInterval(()=>document.querySelector("#clock").textContent=String(Date.now()),100)</script></body></html>'
			);
		});
		await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
		const previewProfile = await request('/browsers', 'POST', {
			name: 'Live preview fixture',
			startUrl: `http://127.0.0.1:${fixture.address().port}/`
		});
		await page.goto(`${base}/#/instances/${previewProfile.id}`);
		await page.locator('.page-head__actions').getByRole('button', { name: '启动', exact: true }).click();
		await page.locator('.status--running').waitFor({ timeout: 30000 });
		await page.getByRole('button', { name: '开始预览', exact: true }).click();
		const liveImage = page.getByAltText('浏览器实时画面');
		await liveImage.waitFor();
		await page.waitForFunction(() => document.querySelector('img[alt="浏览器实时画面"]')?.naturalWidth > 0);
		assert.match(await liveImage.getAttribute('src'), /^blob:/);
		await page.screenshot({ path: path.join(shots, 'live-preview.png'), fullPage: true });
		await page.getByRole('button', { name: '停止预览', exact: true }).click();
		await liveImage.waitFor({ state: 'hidden' });
		await page.getByRole('button', { name: '开始预览', exact: true }).click();
		await liveImage.waitFor();
		await page.locator('.page-head__actions').getByRole('button', { name: '停止', exact: true }).click();
		await page.locator('.status--stopped').waitFor({ timeout: 15000 });
		await page.locator('.live-preview').waitFor({ state: 'hidden' });
		assert.deepEqual(errors, []);
		console.log(
			'Management console e2e passed: resource display, encrypted transfer, confirmed cache cleanup and live preview cleanup.'
		);
	} finally {
		clearTimeout(hardStop);
		await browser?.close();
		await service?.close();
		if (fixture)
			await new Promise((resolve) => {
				fixture.close(resolve);
				fixture.closeAllConnections();
			});
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
