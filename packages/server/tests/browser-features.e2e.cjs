// Explicit browser verification: build first, then node --test tests/browser-features.e2e.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { installBrowserBridge } = require('../dist/browser-bridge');
const { Screencast } = require('../dist/screencast');

async function until(predicate, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for browser fixture');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test('real Chromium: instance OCS bridge, configuration updates and acknowledged CDP screencast frames', async (t) => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-browser-features-'));
	const fixture = http.createServer((_req, res) => {
		res.setHeader('Content-Type', 'text/html');
		res.end(
			'<html><body><h1>Local browser fixture</h1><input id="field"><div id="counter"></div><script>let tick=0;setInterval(()=>{document.querySelector("#counter").textContent=String(++tick)},60)</script></body></html>'
		);
	});
	let browser;
	let cast;
	t.after(async () => {
		await cast?.stop();
		await browser?.close();
		await new Promise((resolve) => {
			fixture.close(resolve);
			fixture.closeAllConnections();
		});
		fs.rmSync(directory, { recursive: true, force: true });
	});
	await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${fixture.address().port}`;
	browser = await chromium.launchPersistentContext(directory, {
		channel: 'chromium',
		headless: true,
		chromiumSandbox: true
	});
	const bridge = await installBrowserBridge(browser, { openSync: true, store: { answerer: 'fixture' } });
	const page = browser.pages()[0];
	await page.goto(base);
	assert.deepEqual(await page.evaluate(() => fetch('/ocs-environment').then((res) => res.json())), {
		environment: 'playwright'
	});
	assert.deepEqual(await page.evaluate(() => fetch('http://localhost:15319/browser').then((res) => res.json())), {
		answerer: 'fixture'
	});
	bridge.setOCS({ openSync: true, store: { answerer: 'updated' } });
	assert.deepEqual(await page.evaluate(() => fetch('http://localhost:15319/browser').then((res) => res.json())), {
		answerer: 'updated'
	});
	const token = await page.evaluate(() => fetch('http://localhost:15319/get-actions-key').then((res) => res.text()));
	const perform = (property, args, suppliedToken = token) =>
		page.evaluate(
			async ({ property, args, token }) => {
				const res = await fetch('/ocs-script-actions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'auth-token': token },
					body: JSON.stringify({ page: location.href, property, args })
				});
				return { status: res.status, body: await res.text() };
			},
			{ property, args, token: suppliedToken }
		);
	assert.equal((await perform('fill', ['#field', 'local-only-value'])).status, 200);
	assert.equal(await page.locator('#field').inputValue(), 'local-only-value');
	assert.equal((await perform('fill', ['#field', 'should-not-apply'], 'wrong')).status, 401);
	assert.equal((await perform('evaluate', ['process.env'])).status, 400);
	assert.equal((await perform('screenshot', [{ path: '/tmp/disallowed.png' }])).status, 400);
	const frames = [];
	cast = new Screencast((frame) => frames.push(frame));
	await cast.start(page, 'fixture-page', { maxWidth: 640, maxHeight: 480 });
	await until(() => frames.length > 0);
	assert.equal(Buffer.from(frames[0].base64, 'base64').readUInt16BE(0), 0xffd8);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(frames.length, 1, 'unacknowledged frames must not fill the IPC channel');
	await cast.acknowledge(frames[0].frameId);
	await until(() => frames.length > 1);
	assert.equal(frames[1].pageId, 'fixture-page');
	await cast.stop();
});
