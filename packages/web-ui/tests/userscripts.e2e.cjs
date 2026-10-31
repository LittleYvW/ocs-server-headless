/** Local-fixture regression for URL/file import, updates, downloads and unsaved edits. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../../..');
const { startServer } = require(path.join(root, 'packages/server/dist/index.js'));
const { loadConfig } = require(path.join(root, 'packages/server/dist/config.js'));

async function main() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-userscripts-ui-'));
	const token = 'userscripts-ui-fixture-token-'.repeat(3);
	let service;
	let browser;
	let origin;
	let version = '1.0';
	const source = (selected = version) =>
		`// ==UserScript==\n// @name UI Source Script\n// @version ${selected}\n// @match *://example.com/*\n// @grant GM_getValue\n// @updateURL ${origin}/meta.js\n// ==/UserScript==\nwindow.version = ${JSON.stringify(
			selected
		)};`;
	const fixture = http.createServer((req, response) =>
		response.end(source(new URL(req.url, 'http://localhost').searchParams.get('version') || version))
	);
	try {
		await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
		origin = `http://127.0.0.1:${fixture.address().port}`;
		service = await startServer(loadConfig({ OCS_DATA_DIR: directory, OCS_AUTH_TOKEN: token, OCS_PORT: '0' }));
		browser = await chromium.launch({
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			...(process.env.OCS_E2E_BROWSER ? { executablePath: process.env.OCS_E2E_BROWSER } : {})
		});
		const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(`http://127.0.0.1:${service.server.address().port}/`);
		await page.getByLabel('管理令牌').fill(token);
		await page.getByRole('button', { name: '建立连接', exact: true }).click();
		await page.locator('.shell').waitFor();
		await page.locator('a.nav-item', { hasText: '用户脚本' }).click();
		await page.getByRole('button', { name: '导入 .user.js', exact: true }).click();
		await page.locator('.modal input[type=url]').fill(origin + '/script.user.js');
		await page.locator('.modal').getByRole('button', { name: '导入脚本', exact: true }).click();
		await page.locator('.script-item', { hasText: 'UI Source Script' }).waitFor();
		await page.locator('.source-summary', { hasText: 'v1.0' }).waitFor();
		assert.equal(await page.getByLabel('脚本运行方式').inputValue(), 'userscript');
		assert.equal(await page.locator('textarea[placeholder^="https://example.com/*"]').count(), 0);
		console.log('  ✓ URL import displays parsed metadata and uses standard userscript mode');

		version = '2.0';
		await page.getByRole('button', { name: '检查更新', exact: true }).click();
		await page.locator('.source-actions', { hasText: '可更新至 2.0' }).waitFor();
		assert.equal(service.store.read().userScripts[0].version, '1.0');
		await page.getByRole('button', { name: '从来源更新', exact: true }).click();
		await page.getByRole('button', { name: '下载并更新', exact: true }).click();
		await page.locator('.source-summary', { hasText: 'v2.0' }).waitFor();
		const downloadPending = page.waitForEvent('download');
		await page.getByRole('button', { name: '下载已保存 .user.js', exact: true }).click();
		const download = await downloadPending;
		assert.ok(download.suggestedFilename().endsWith('.user.js'));
		assert.equal(fs.readFileSync(await download.path(), 'utf8'), source());
		console.log('  ✓ checking is read-only; confirmed update and authenticated .user.js download work');

		await page.locator('.code-editor').fill(source() + '\n// unsaved');
		await page.getByRole('button', { name: '导入 .user.js', exact: true }).click();
		await page.getByRole('button', { name: '取消', exact: true }).click();
		assert.ok((await page.locator('.code-editor').inputValue()).includes('// unsaved'));
		await page.getByRole('button', { name: '导入 .user.js', exact: true }).click();
		await page.getByRole('button', { name: '放弃并切换', exact: true }).click();
		await page.getByLabel('导入来源').selectOption('file');
		const local = source().replace('UI Source Script', 'Local File Script');
		await page
			.locator('.modal input[type=file]')
			.setInputFiles({ name: 'local.user.js', mimeType: 'application/javascript', buffer: Buffer.from(local) });
		await page.locator('.modal').getByRole('button', { name: '导入脚本', exact: true }).click();
		await page.locator('.script-item', { hasText: 'Local File Script' }).waitFor();
		assert.equal(service.store.read().userScripts.length, 2);
		assert.equal(service.store.read().userScripts[1].sourceUrl, undefined);
		assert.equal(await page.locator('.code-editor').inputValue(), local);
		console.log('  ✓ local file import reads browser-selected bytes and preserves unsaved-edit confirmation');
		// Provider mapping is exercised by catalog.test.ts against real HTTP fixtures.
		// Here the console selects a catalog entry/version, then imports its actual local source through the backend.
		await page.route('**/api/v1/script-catalog**', async (route) => {
			const url = new URL(route.request().url());
			const data = url.pathname.endsWith('/versions')
				? [{ version: '1.0', codeUrl: origin + '/script.user.js?version=1.0' }]
				: {
						provider: url.searchParams.get('provider'),
						page: 1,
						items: [
							{
								id: '123',
								name: 'Catalog Fixture',
								description: 'Local catalog item',
								version: '2.0',
								codeUrl: origin + '/script.user.js'
							}
						]
				  };
			await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) });
		});
		await page.getByRole('button', { name: '导入 .user.js', exact: true }).click();
		await page.getByLabel('导入来源').selectOption('catalog');
		await page.getByLabel('脚本来源').selectOption('greasyfork');
		await page.locator('.catalog-search input').fill('Catalog');
		await page.getByRole('button', { name: '搜索', exact: true }).click();
		await page.locator('.catalog-item', { hasText: 'Catalog Fixture' }).click();
		await page.getByLabel('安装版本').selectOption({ label: '1.0' });
		await page.locator('.modal').getByRole('button', { name: '导入脚本', exact: true }).click();
		await page.locator('.source-summary', { hasText: 'v1.0' }).waitFor();
		assert.equal(service.store.read().userScripts.length, 3);
		assert.equal(service.store.read().userScripts[2].sourceUrl, origin + '/script.user.js?version=1.0');
		assert.equal(service.store.read().userScripts[2].version, '1.0');
		await page.getByRole('button', { name: '检查更新', exact: true }).click();
		await page.locator('.source-actions', { hasText: '当前无新版本' }).waitFor();
		assert.deepEqual(errors, []);
		console.log(
			'  ✓ catalog source/search/version selection imports a pinned source and keeps it pinned during update checks'
		);
		if (process.env.OCS_E2E_SHOTS) {
			fs.mkdirSync(process.env.OCS_E2E_SHOTS, { recursive: true });
			await page.screenshot({ path: path.join(process.env.OCS_E2E_SHOTS, 'userscripts.png'), fullPage: true });
		}
	} finally {
		await browser?.close();
		await service?.close();
		fixture.closeAllConnections();
		await new Promise((resolve) => fixture.close(resolve));
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
