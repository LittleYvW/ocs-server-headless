const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { prepareScriptManager } = require('../dist/manager');
const { loadConfig } = require('../dist/config');
const { startServer } = require('../dist/index');

test(
	'management API runs standard scripts and reconciles disable/unbind across worker restarts',
	{ timeout: 120000 },
	async (t) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-managed-api-'));
		let service;
		const fixture = http.createServer((req, res) => {
			res.setHeader('Content-Type', req.url === '/lib.js' ? 'application/javascript' : 'text/html');
			res.end(
				req.url === '/lib.js'
					? 'window.fixtureLibrary="required";'
					: '<title>Original fixture</title><input id="field">'
			);
		});
		t.after(async () => {
			await service?.close();
			await new Promise((resolve) => {
				fixture.close(resolve);
				fixture.closeAllConnections();
			});
			fs.rmSync(directory, { recursive: true, force: true });
		});
		await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
		const target = `http://127.0.0.1:${fixture.address().port}`;
		const extensions = await prepareScriptManager({
			dataDir: directory,
			extensions: process.env.OCS_TEST_MANAGER_DIR ? [process.env.OCS_TEST_MANAGER_DIR] : []
		});
		const token = 'managed-api-fixture-'.repeat(4);
		service = await startServer(
			loadConfig({
				OCS_DATA_DIR: directory,
				OCS_PORT: '0',
				OCS_AUTH_TOKEN: token,
				OCS_EXTENSIONS: JSON.stringify(extensions)
			})
		);
		const base = `http://127.0.0.1:${service.server.address().port}`;
		const api = async (route, method = 'GET', body) => {
			const response = await fetch(base + '/api/v1' + route, {
				method,
				headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(110000)
			});
			const payload = response.status === 204 ? undefined : await response.json();
			assert.equal(response.ok, true, JSON.stringify(payload));
			return payload?.data;
		};
		const code = `// ==UserScript==
// @name Managed API fixture
// @namespace ocs-api-test
// @version 1.0
// @match ${target}/*
// @run-at document-end
// @grant GM_getValue
// @grant GM_setValue
// @grant GM_xmlhttpRequest
// @grant GM.xmlHttpRequest
// @connect localhost
// @connect 127.0.0.1
// @require ${target}/lib.js
// ==/UserScript==
const count = GM_getValue('count', 0) + 1;
GM_setValue('count', count);
GM_xmlhttpRequest({url:'http://localhost:15319/browser',onload: async response => {
	const config = JSON.parse(response.responseText);
	const key = await GM.xmlHttpRequest({url:'http://localhost:15319/get-actions-key'});
	const result = await fetch('/ocs-script-actions', { method:'POST', headers:{'content-type':'application/json','auth-token':key.responseText},
		body: JSON.stringify({page:location.href,property:'fill',args:['#field','managed action']}) });
	if(result.ok) document.title = count + ':' + window.fixtureLibrary + ':' + config.fixture;
}});`;
		const script = await api('/user-scripts/import', 'POST', { code });
		const profile = await api('/browsers', 'POST', {
			name: 'Managed fixture',
			startUrl: target + '/',
			userScriptIds: [script.id]
		});
		await api('/settings', 'PATCH', { ocs: { openSync: true, store: { fixture: 'configured' } } });
		const browserPath = '/browsers/' + profile.id;
		const title = async (expected) => {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				if ((await api(browserPath + '/pages')).some((page) => page.url === target + '/' && page.title === expected))
					return;
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			assert.fail(`Managed fixture did not report ${expected}`);
		};
		await api(browserPath + '/start', 'POST');
		await title('1:required:configured');
		assert.equal(
			(await api('/user-scripts/' + script.id)).code,
			code,
			'installation adapters must not change saved source'
		);
		assert.equal((await fetch(base + '/browser')).status, 404, 'legacy reads must remain private to the instance');
		await api('/user-scripts/' + script.id, 'PATCH', { enabled: false });
		await api(browserPath + '/restart', 'POST');
		await new Promise((resolve) => setTimeout(resolve, 500));
		await title('Original fixture');
		await api('/user-scripts/' + script.id, 'PATCH', { enabled: true });
		await api(browserPath + '/restart', 'POST');
		await title('2:required:configured');
		await api(browserPath + '/stop', 'POST');
		await api(browserPath, 'PATCH', { userScriptIds: [] });
		await api(browserPath + '/start', 'POST');
		await new Promise((resolve) => setTimeout(resolve, 500));
		await title('Original fixture');
		const downloads = await api(browserPath + '/downloads');
		assert.deepEqual(downloads, [], 'internal manager operations must not create user downloads');
		assert.equal(JSON.stringify(await api('/logs?limit=500')).includes(token), false);
	}
);
