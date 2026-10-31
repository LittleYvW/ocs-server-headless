const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright-core');
const { prepareScriptManager, installManagedScripts } = require('../dist/manager');
const { installBrowserBridge } = require('../dist/browser-bridge');

test('real script manager preserves GM storage and reconciles enabled scripts', async (t) => {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-managed-script-'));
	let browser;
	let bridge;
	const fixture = http.createServer((req, res) => {
		if (req.url === '/lib.js') {
			res.setHeader('Content-Type', 'application/javascript');
			res.end('window.auditLibrary="loaded"');
			return;
		}
		res.setHeader('Content-Type', 'text/html');
		res.end('<title>Local manager fixture</title><body>Fixture<input id="bridge-field"></body>');
	});
	t.after(async () => {
		await browser?.close();
		await bridge?.close();
		await new Promise((resolve) => {
			fixture.close(resolve);
			fixture.closeAllConnections();
		});
		fs.rmSync(dataDir, { recursive: true, force: true });
	});
	await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${fixture.address().port}`;
	const configured = process.env.OCS_TEST_MANAGER_DIR ? [process.env.OCS_TEST_MANAGER_DIR] : [];
	const extensions = await prepareScriptManager({ dataDir, extensions: configured });
	const launch = async () => {
		browser = await chromium.launchPersistentContext(path.join(dataDir, 'profiles', 'fixture'), {
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			executablePath: process.env.OCS_BROWSER_EXECUTABLE_PATH || undefined,
			ignoreDefaultArgs: ['--disable-extensions'],
			args: [`--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`]
		});
		bridge = await installBrowserBridge(browser, { openSync: true, store: { fixture: 'managed-background' } });
	};
	const script = {
		id: 'fixture-script',
		name: 'OCS manager fixture',
		mode: 'userscript',
		enabled: true,
		code: `// ==UserScript==\n// @name OCS manager fixture\n// @namespace ocs-manager-fixture\n// @version 1.0.0\n// @match ${base}/*\n// @exclude ${base}/private*\n// @run-at document-end\n// @grant GM_setValue\n// @grant GM_getValue\n// @grant GM_xmlhttpRequest\n// @connect localhost\n// @connect 127.0.0.1\n// @require ${base}/lib.js\n// ==/UserScript==\nconst count=GM_getValue('count',0)+1;GM_setValue('count',count);document.body.dataset.result=count+':'+window.auditLibrary;\nGM_xmlhttpRequest({url:'http://localhost:15319/browser',onload:r=>document.body.dataset.bridge=JSON.parse(r.responseText).fixture,onerror:()=>document.body.dataset.bridge='error'});\nGM_xmlhttpRequest({url:'http://localhost:15319/get-actions-key',onload:r=>fetch('/ocs-script-actions',{method:'POST',headers:{'content-type':'application/json','auth-token':r.responseText},body:JSON.stringify({page:location.href,property:'fill',args:['#bridge-field','GM bridge action']})})});`,
		matches: [`${base}/*`],
		version: '1.0.0',
		createdAt: '',
		updatedAt: ''
	};
	const install = async (scripts) =>
		installManagedScripts(browser, {
			scripts,
			dataDir,
			profileId: 'fixture',
			onEvent: () => {},
			backgroundUrl: await bridge.backgroundUrl()
		});
	const result = async (expected) => {
		const page = await browser.newPage();
		await page.goto(base);
		if (expected) {
			await page.waitForFunction((value) => document.body.dataset.result === value, expected, { timeout: 15000 });
		} else await page.waitForTimeout(1000);
		assert.equal(await page.getAttribute('body', 'data-result'), expected);
		if (expected) {
			await page.waitForFunction(() => document.body.dataset.bridge === 'managed-background', undefined, {
				timeout: 10000
			});
			await page.waitForFunction(
				() => document.querySelector('#bridge-field').value === 'GM bridge action',
				undefined,
				{ timeout: 10000 }
			);
		}
		await page.close();
	};
	await launch();
	await install([script]);
	await new Promise((resolve) => setTimeout(resolve, 1000));
	await result('1:loaded');
	const excluded = await browser.newPage();
	await excluded.goto(base + '/private');
	await excluded.waitForTimeout(300);
	assert.equal(await excluded.getAttribute('body', 'data-result'), null);
	await excluded.close();
	await browser.close();
	await bridge.close();
	await launch();
	await install([script]);
	await result('2:loaded');
	await install([]);

	await result(null);
	await install([script]);
	await result('3:loaded');
	const updated = {
		...script,
		code: script.code
			.replace('@version 1.0.0', '@version 1.1.0')
			.replace("count+':'+window.auditLibrary", "'updated:'+count+':'+window.auditLibrary"),
		version: '1.1.0'
	};
	await install([updated]);
	await result('updated:4:loaded');
	const second = {
		...script,
		id: 'second-script',
		code:
			script.code
				.split('// ==/UserScript==')[0]
				.replace('@namespace ocs-manager-fixture', '@namespace second-namespace')
				.replace('@match ' + base + '/*', '@match https://fixture.invalid/*') +
			'// ==/UserScript==\ndocument.body.dataset.second="yes";'
	};
	await install([updated, second]);
	await install([second]);
	await result(null);
	await install([updated]);
	await result('updated:5:loaded');
});
