/** Exercises the real console, HTTP input queue, worker and scaled Chromium screencast together. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { startServer } = require('../../server/dist/index');
const { loadConfig } = require('../../server/dist/config');

async function until(predicate, label, timeout = 15000) {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out: ' + label);
		await new Promise((resolve) => setTimeout(resolve, 40));
	}
}

async function main() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-control-e2e-'));
	const token = 'control-fixture-token-1234567890abcdef';
	const reports = new Map();
	let service;
	let browser;
	let page;
	const deadline = setTimeout(() => {
		console.error('Browser control e2e exceeded 3 minutes');
		process.exit(1);
	}, 180000);
	const html = `<!doctype html><html><meta charset="utf-8"><title>Remote input fixture</title>
	<style>body{margin:0;background:#e9eef4;color:#17202e;font:20px system-ui;min-height:1800px}
	h1{margin:20px}input{position:absolute;left:180px;top:100px;width:320px;height:44px;box-sizing:border-box;font:22px system-ui}
	button{position:absolute;left:550px;top:100px;width:160px;height:44px;font:20px system-ui}
	#scroll{position:absolute;left:180px;top:250px;width:600px;height:200px;overflow:auto;background:#fff}
	#scroll div{height:1200px;background:linear-gradient(#fff,#a0c8c0)}#status{position:absolute;top:170px;left:180px}</style>
	<h1>Remote input fixture</h1><input id="field" autocomplete="off"><button id="button">Submit</button><p id="status"></p>
	<div id="scroll"><div>Scroll this panel</div></div><script>
	let clicks=0,keys=[];const field=document.getElementById('field'),scroll=document.getElementById('scroll');
	document.getElementById('button').onclick=()=>{clicks++;document.getElementById('status').textContent=field.value};
	document.addEventListener('keydown',event=>keys.push(event.key));
	setInterval(()=>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,value:field.value,active:document.activeElement.id,clicks,keys:keys.slice(-50),scroll:scroll.scrollTop})}).catch(()=>{}),80);
	</script></html>`;
	const fixture = http.createServer((req, res) => {
		if (req.url === '/report') {
			let body = '';
			req.on('data', (part) => {
				body += part;
			});
			req.on('end', () => {
				const report = JSON.parse(body);
				reports.set(report.path, report);
				res.end('ok');
			});
		} else {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(html);
		}
	});
	try {
		await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
		const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
		service = await startServer(
			loadConfig({
				OCS_DATA_DIR: directory,
				OCS_AUTH_TOKEN: token,
				OCS_PORT: '0',
				OCS_BROWSER_EXECUTABLE_PATH: process.env.OCS_E2E_BROWSER
			})
		);
		const base = `http://127.0.0.1:${service.server.address().port}`;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const api = async (route, method = 'GET', body) => {
			const response = await fetch(base + '/api/v1' + route, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			assert.equal(response.ok, true, `${route}: ${response.status}`);
			return (await response.json()).data;
		};
		const profile = await api('/browsers', 'POST', { name: '直接操作回归', startUrl: fixtureBase + '/first' });
		await api(`/browsers/${profile.id}/start`, 'POST');
		const firstPage = (await api(`/browsers/${profile.id}/pages`))[0];
		browser = await chromium.launch({
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			...(process.env.OCS_E2E_BROWSER ? { executablePath: process.env.OCS_E2E_BROWSER } : {})
		});
		page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
		const errors = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.goto(base + '/');
		await page.getByLabel('管理令牌', { exact: true }).fill(token);
		await page.getByRole('button', { name: '建立连接', exact: true }).click();
		await page.locator('.shell').waitFor();
		await page.goto(base + '/#/instances/' + profile.id);
		const preview = page.locator('.live-preview');
		const image = preview.locator('img');
		const rendered = async () => {
			await until(() => image.evaluate((element) => element.naturalWidth > 0).catch(() => false), 'screencast image');
		};
		await rendered();
		assert.equal(await page.locator('.shot').count(), 0, 'screenshot polling UI is suspended during preview');
		assert.equal(await page.locator('.advanced-actions').getAttribute('open'), null);
		await preview.getByRole('button', { name: '直接操作', exact: true }).click();
		await preview.getByRole('button', { name: '仅查看', exact: true }).waitFor();
		// Reacquisition must wait for a slow release instead of racing the old owner.
		await page.route('**/control', async (route) => {
			if (route.request().method() === 'DELETE') await new Promise((resolve) => setTimeout(resolve, 150));
			await route.continue();
		});
		await preview.getByRole('button', { name: '仅查看', exact: true }).click();
		await preview.getByRole('button', { name: '直接操作', exact: true }).click();
		await preview.getByRole('button', { name: '仅查看', exact: true }).waitFor();
		await page.unroute('**/control');
		const clickRemote = async (x, y) => {
			const bounds = await image.boundingBox();
			assert.ok(bounds.width < 1365, 'fixture must exercise a scaled preview');
			await image.click({ position: { x: (x * bounds.width) / 1365, y: (y * bounds.height) / 900 } });
		};
		await clickRemote(320, 120);
		await until(() => reports.get('/first')?.active === 'field', 'scaled click focuses remote field');
		await page.keyboard.type('abc');
		await until(() => reports.get('/first')?.value === 'abc', 'keyboard typing');
		await page.keyboard.press('Control+a');
		await page.keyboard.type('ordered');
		await until(() => reports.get('/first')?.value === 'ordered', 'shortcut and following text stay ordered');

		// Exercise the same composition/input DOM events generated by a local IME.
		await preview.getByLabel('远程键盘输入').evaluate((element) => {
			element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
			element.value = '中文';
			element.dispatchEvent(
				new InputEvent('input', { bubbles: true, data: '中文', inputType: 'insertCompositionText', isComposing: true })
			);
			element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
			element.dispatchEvent(new InputEvent('input', { bubbles: true, data: '中文', inputType: 'insertText' }));
		});
		await until(() => reports.get('/first')?.value === 'ordered中文', 'IME commits exactly once');
		await page.waitForTimeout(200);
		assert.equal(reports.get('/first').value, 'ordered中文');
		await preview.getByLabel('远程键盘输入').evaluate((element) => {
			const data = new DataTransfer();
			data.setData('text/plain', '粘贴');
			element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
		});
		await until(() => reports.get('/first')?.value === 'ordered中文粘贴', 'local text paste');
		await preview.getByLabel('发送到远端的文字').fill('发送');
		await preview.getByRole('button', { name: '发送文字', exact: true }).click();
		await until(() => reports.get('/first')?.value === 'ordered中文粘贴发送', 'explicit Chinese text entry');
		await clickRemote(620, 120);
		await until(() => reports.get('/first')?.clicks === 1, 'scaled button click');
		const bounds = await image.boundingBox();
		await page.mouse.move(bounds.x + (400 * bounds.width) / 1365, bounds.y + (330 * bounds.height) / 900);
		await page.mouse.wheel(0, 220);
		await until(() => reports.get('/first')?.scroll > 0, 'wheel targets the nested remote scroll panel');
		console.log('  ✓ scaled clicks, ordered keys/text, IME, paste and nested scrolling');

		if (process.env.OCS_E2E_SHOTS) {
			fs.mkdirSync(process.env.OCS_E2E_SHOTS, { recursive: true });
			await page.screenshot({ path: path.join(process.env.OCS_E2E_SHOTS, 'browser-control.png'), fullPage: true });
		}
		await page.keyboard.press('Control+Alt+Escape');
		await preview.getByRole('button', { name: '直接操作', exact: true }).waitFor();
		assert.equal(await preview.getByLabel('远程键盘输入').inputValue(), '');

		// A late request from the old page must fail after switching the active tab.
		const acquiredPromise = page.waitForResponse(
			(response) => response.url().endsWith('/control') && response.request().method() === 'POST'
		);
		await preview.getByRole('button', { name: '直接操作', exact: true }).click();
		const oldSession = (await (await acquiredPromise).json()).data;
		await preview.getByRole('button', { name: '仅查看', exact: true }).waitFor();
		await page.getByRole('button', { name: '新建标签页', exact: true }).click();
		await until(async () => (await api(`/browsers/${profile.id}/pages`)).length === 2, 'new tab');
		await until(
			() =>
				page
					.locator('.page-item.is-active .page-item__url')
					.textContent()
					.then((value) => value === 'about:blank'),
			'new tab selection'
		);
		const late = await fetch(`${base}/api/v1/browsers/${profile.id}/input`, {
			method: 'POST',
			headers,
			body: JSON.stringify({
				pageId: oldSession.pageId,
				sessionId: oldSession.sessionId,
				sequence: 1,
				events: [{ type: 'text', text: 'stale-private-input' }]
			})
		});
		assert.equal(late.status, 409);
		assert.equal((await late.json()).error.code, 'CONTROL_EXPIRED');
		const navigation = page.locator('input[placeholder="https://example.com"]');
		await navigation.fill(fixtureBase + '/second');
		await page.getByRole('button', { name: '前往', exact: true }).click();
		await until(() => reports.has('/second'), 'second tab navigation');
		await page.getByRole('button', { name: '后退', exact: true }).click();
		await until(
			() =>
				page
					.locator('.page-item.is-active .page-item__url')
					.textContent()
					.then((value) => value === 'about:blank'),
			'back navigation'
		);
		await page.getByRole('button', { name: '前进', exact: true }).click();
		await until(
			() =>
				page
					.locator('.page-item.is-active .page-item__url')
					.textContent()
					.then((value) => value === fixtureBase + '/second'),
			'forward navigation'
		);
		await page.getByRole('button', { name: '关闭标签页', exact: true }).click();
		await until(async () => (await api(`/browsers/${profile.id}/pages`)).length === 1, 'tab close');
		await until(
			() =>
				page
					.locator('.page-item.is-active .page-item__url')
					.textContent()
					.then((value) => value === fixtureBase + '/first'),
			'remaining tab selected'
		);
		await rendered();
		await preview.getByRole('button', { name: '直接操作', exact: true }).click();
		await preview.getByRole('button', { name: '仅查看', exact: true }).waitFor();
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await preview.getByRole('button', { name: '直接操作', exact: true }).waitFor();
		console.log('  ✓ tab creation/history/close, stale-session rejection and blur cleanup');

		await preview.getByRole('button', { name: '停止预览', exact: true }).click();
		await page.locator('.shot img').waitFor();
		const logs = JSON.stringify(await api('/logs'));
		const disk = fs.readFileSync(path.join(directory, 'logs', 'events.jsonl'), 'utf8');
		for (const text of ['stale-private-input', 'ordered中文粘贴发送', 'screencast-frame']) {
			assert.equal(logs.includes(text), false);
			assert.equal(disk.includes(text), false);
		}
		assert.deepEqual(errors, []);
		assert.equal(firstPage.id, (await api(`/browsers/${profile.id}/pages`))[0].id);
		console.log('Browser control e2e passed.');
	} catch (error) {
		if (page)
			console.error(
				'Control UI:',
				await page
					.locator('.live-preview')
					.innerText()
					.catch(() => 'unavailable')
			);
		throw error;
	} finally {
		clearTimeout(deadline);
		await browser?.close();
		await service?.close();
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
