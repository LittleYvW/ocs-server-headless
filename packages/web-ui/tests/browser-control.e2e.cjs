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
	<style>#hover{position:absolute;left:900px;top:100px;width:200px;height:60px;background:#bdd5cd}#hover-panel{display:none}#hover:hover #hover-panel{display:block}
	#range{left:850px;top:250px;width:300px;height:40px}#drag{position:absolute;left:900px;top:370px;width:80px;height:50px;background:#8aacd0}
	#drop{position:absolute;left:1100px;top:360px;width:180px;height:100px;border:2px dashed #527065}#shadow-host{position:absolute;left:850px;top:510px}
	#embedded{position:absolute;left:850px;top:650px;width:460px;height:160px;border:4px solid #557;transform:scale(.8);transform-origin:top left}</style>
	<h1>Remote input fixture</h1><input id="field" autocomplete="off"><button id="button">Submit</button><p id="status"></p>
	<div id="hover">Hover here<div id="hover-panel">Hover opened</div></div><input id="range" type="range" min="0" max="100" value="0">
	<div id="drag" draggable="true">Drag</div><div id="drop">Drop here</div><div id="shadow-host"></div><iframe id="embedded"></iframe>
	<div id="scroll"><div>Scroll this panel</div></div><script>
	let clicks=0,doubles=0,drops=0,buttons=0,downs=0,keys=[];const field=document.getElementById('field'),scroll=document.getElementById('scroll');
	const shadow=document.getElementById('shadow-host').attachShadow({mode:'open'});shadow.innerHTML='<input id="field" style="width:260px;height:44px;box-sizing:border-box;font:20px system-ui">';
	document.getElementById('embedded').src='http://localhost:'+location.port+'/embedded';
	document.getElementById('button').ondblclick=()=>doubles++;
	for(const name of ['mousedown','mouseup','mousemove'])document.addEventListener(name,event=>buttons=event.buttons);
	document.addEventListener('mousedown',()=>downs++);
	document.getElementById('drag').ondragstart=event=>event.dataTransfer.setData('text/plain','drag-fixture');
	document.getElementById('drop').ondragover=event=>event.preventDefault();
	document.getElementById('drop').ondrop=event=>{event.preventDefault();if(event.dataTransfer.getData('text/plain')==='drag-fixture')drops++};
	document.getElementById('button').onclick=()=>{clicks++;document.getElementById('status').textContent=field.value};
	document.addEventListener('keydown',event=>keys.push(event.key));
	setInterval(()=>fetch('/report',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:location.pathname,value:field.value,shadow:shadow.querySelector('input').value,active:document.activeElement.id,clicks,doubles,drops,buttons,downs,hover:getComputedStyle(document.getElementById('hover-panel')).display!=='none',range:document.getElementById('range').value,keys:keys.slice(-50),scroll:scroll.scrollTop})}).catch(()=>{}),80);
	</script></html>`;
	const fixture = http.createServer((req, res) => {
		if (req.url === '/embedded') {
			res.setHeader('Content-Type', 'text/html; charset=utf-8');
			res.end(
				`<!doctype html><html><style>body{margin:0;background:#e5ebf2}input{position:absolute;left:20px;top:20px;width:260px;height:36px;box-sizing:border-box}</style><input id="inside"><script>setInterval(()=>fetch('/report',{method:'POST',body:JSON.stringify({path:'/embedded',value:document.querySelector('input').value})}).catch(()=>{}),80)</script></html>`
			);
		} else if (req.url === '/report') {
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

		const moveRemote = async (x, y, steps = 1) => {
			await image.scrollIntoViewIfNeeded();
			const box = await image.boundingBox();
			await page.mouse.move(box.x + (x * box.width) / 1365, box.y + (y * box.height) / 900, { steps });
		};
		await moveRemote(1000, 125);
		await until(() => reports.get('/first')?.hover, 'remote hover opens a CSS menu');
		await image.dblclick({
			position: {
				x: (620 * (await image.boundingBox()).width) / 1365,
				y: (120 * (await image.boundingBox()).height) / 900
			}
		});
		await until(() => reports.get('/first')?.doubles === 1, 'double click emits exactly one remote dblclick');
		await moveRemote(865, 270);
		await page.mouse.down();
		await moveRemote(1140, 270, 16);
		await page.mouse.up();
		await until(
			() => Number(reports.get('/first')?.range) > 80 && reports.get('/first')?.buttons === 0,
			'held range-slider drag and release'
		);
		await moveRemote(940, 395);
		await page.mouse.down();
		await moveRemote(1190, 410, 18);
		await page.mouse.up();
		await until(() => reports.get('/first')?.drops === 1, 'native HTML5 drag and drop');
		const downsBeforeBlur = reports.get('/first').downs;
		await moveRemote(1000, 270);
		await page.mouse.down();
		await until(
			() => reports.get('/first')?.buttons === 1 && reports.get('/first')?.downs > downsBeforeBlur,
			'remote button held before blur'
		);
		const valueBeforeBlur = reports.get('/first').range;
		await page.evaluate(() => window.dispatchEvent(new Event('blur')));
		await page.mouse.up();
		await until(() => reports.get('/first')?.buttons === 0, 'blur releases a held remote pointer');
		assert.equal(
			reports.get('/first').range,
			valueBeforeBlur,
			'cleanup does not move the slider away from the last pointer position'
		);
		console.log('  ✓ hover, double click, range drag, HTML5 drop and interrupted-drag cleanup');

		const pickRemote = async (x, y) => {
			await preview.getByRole('button', { name: '拾取元素', exact: true }).click();
			await preview.getByRole('button', { name: '结束拾取', exact: true }).waitFor();
			await moveRemote(x, y);
			await clickRemote(x, y);
			await preview.getByRole('button', { name: '用于填充', exact: true }).waitFor();
			return preview.getByLabel('拾取的选择器', { exact: true }).inputValue();
		};
		const clicksBeforePick = reports.get('/first').clicks;
		assert.ok((await pickRemote(320, 120)).length > 0);
		const highlight = await preview.locator('.element-highlight').boundingBox();
		const shot = await image.boundingBox();
		assert.ok(Math.abs(highlight.x - shot.x - (180 * shot.width) / 1365) < 2, 'picker overlay follows scaled bounds');
		assert.equal(reports.get('/first').clicks, clicksBeforePick, 'picking does not click the remote document');
		await preview.getByLabel('拾取的选择器', { exact: true }).focus();
		await page.keyboard.press('Escape');
		await preview.getByRole('button', { name: '拾取元素', exact: true }).waitFor();
		await pickRemote(320, 120);
		await preview.getByRole('button', { name: '用于填充', exact: true }).click();
		const fillPicked = async (text) => {
			await page.locator('input[placeholder="临时输入值"]').fill(text);
			await page.getByRole('button', { name: '填充', exact: true }).click();
		};
		await fillPicked('picked-main');
		await until(
			() => reports.get('/first')?.value === 'picked-main',
			'picked selector fills the exact main-frame node despite a duplicate shadow ID'
		);
		assert.equal(reports.get('/first').shadow, '');
		const shadowSelector = await pickRemote(980, 532);
		assert.match(shadowSelector, /shadow-host/);
		await preview.getByRole('button', { name: '用于填充', exact: true }).click();
		await fillPicked('picked-shadow');
		await until(() => reports.get('/first')?.shadow === 'picked-shadow', 'picked shadow selector is reusable');
		const frameInfo = JSON.parse(await pickRemote(973, 684));
		assert.deepEqual(frameInfo.framePath, ['css=#embedded']);
		assert.equal(frameInfo.selector, 'css=#inside');
		assert.equal(
			await preview.getByLabel('远程键盘输入').evaluate(
				(element) =>
					!element.dispatchEvent(
						new InputEvent('beforeinput', {
							bubbles: true,
							cancelable: true,
							inputType: 'deleteContentBackward'
						})
					)
			),
			true,
			'picker blocks editing keys from virtual keyboards'
		);
		const frameHighlight = await preview.locator('.element-highlight').boundingBox();
		const frameShot = await image.boundingBox();
		assert.ok(
			Math.abs(frameHighlight.width - (208 * frameShot.width) / 1365) < 2,
			'iframe highlight accounts for the frame CSS scale'
		);
		assert.ok(
			Math.abs(frameHighlight.x - frameShot.x - (869.2 * frameShot.width) / 1365) < 2,
			'iframe highlight accounts for scaled frame borders'
		);
		if (process.env.OCS_E2E_SHOTS) {
			fs.mkdirSync(process.env.OCS_E2E_SHOTS, { recursive: true });
			await page.screenshot({
				path: path.join(process.env.OCS_E2E_SHOTS, 'browser-element-picker.png'),
				fullPage: true
			});
		}
		await preview.getByRole('button', { name: '用于填充', exact: true }).click();
		await fillPicked('picked-frame');
		await until(
			() => reports.get('/embedded')?.value === 'picked-frame',
			'picked cross-origin iframe selector is reusable'
		);
		assert.equal(reports.get('/first').value, 'picked-main');
		assert.equal(await page.locator('.ops .inline-error').count(), 0);
		console.log('  ✓ read-only picking, scaled overlay, shadow DOM and bordered/scaled cross-origin iframe targeting');
		await preview.getByRole('button', { name: '直接操作', exact: true }).click();
		await preview.getByRole('button', { name: '仅查看', exact: true }).waitFor();

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
		for (const text of ['stale-private-input', 'ordered中文粘贴发送', 'picked-frame', 'screencast-frame']) {
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
