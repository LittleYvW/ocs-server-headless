/** Explicit real-browser HTTP integration: build server, then node --test this file. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../dist/index');
const { loadConfig } = require('../dist/config');

async function until(predicate, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for local HTTP fixture');
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
}

async function firstFrame(reader) {
	let bytes = Buffer.alloc(0);
	for (;;) {
		const part = await reader.read();
		assert.equal(part.done, false, 'Preview ended before its first frame');
		bytes = Buffer.concat([bytes, Buffer.from(part.value)]);
		const headerEnd = bytes.indexOf('\r\n\r\n');
		if (headerEnd < 0) continue;
		const header = bytes.subarray(0, headerEnd).toString('ascii');
		assert.match(header, /Content-Type: image\/jpeg/);
		const length = Number(header.match(/Content-Length: (\d+)/)[1]);
		if (bytes.length < headerEnd + 4 + length) continue;
		const image = bytes.subarray(headerEnd + 4, headerEnd + 4 + length);
		assert.equal(image.readUInt16BE(0), 0xffd8);
		assert.equal(image.readUInt16BE(image.length - 2), 0xffd9);
		return image;
	}
}

test(
	'real HTTP: per-instance browser parameters reach Chromium and reset on the same profile',
	{ timeout: 90000 },
	async (t) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-browser-options-'));
		const token = 'browser-options-fixture-token-1234567890';
		const reports = [];
		let service;
		const fixture = http.createServer((req, res) => {
			if (req.url === '/report') {
				let body = '';
				req.on('data', (part) => {
					body += part;
				});
				req.on('end', () => {
					reports.push({ ...JSON.parse(body), headers: req.headers });
					res.end('ok');
				});
				return;
			}
			res.setHeader('Content-Type', 'text/html');
			res.end(`<!doctype html><script>
			fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
				path: location.pathname, language: navigator.language, languages: navigator.languages,
				locale: Intl.DateTimeFormat().resolvedOptions().locale,
				timezoneId: Intl.DateTimeFormat().resolvedOptions().timeZone,
				userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight }
			}) });
		</script>`);
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
		service = await startServer(loadConfig({ OCS_DATA_DIR: directory, OCS_AUTH_TOKEN: token, OCS_PORT: '0' }));
		const base = `http://127.0.0.1:${service.server.address().port}/api/v1`;
		const fixtureBase = `http://127.0.0.1:${fixture.address().port}`;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const api = async (route, method = 'GET', body) => {
			const response = await fetch(base + route, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			assert.equal(response.ok, true, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
			return (await response.json()).data;
		};
		const defaults = await api('/browsers', 'POST', {
			name: 'Default parameters',
			startUrl: fixtureBase + '/defaults'
		});
		await api(`/browsers/${defaults.id}/start`, 'POST');
		await until(() => reports.some((report) => report.path === '/defaults'));
		const baseline = reports.find((report) => report.path === '/defaults');
		assert.deepEqual(baseline.viewport, { width: 1365, height: 900 });
		const options = {
			locale: 'fr-FR',
			timezoneId: 'Europe/Paris',
			userAgent: 'OCS options fixture/1.0',
			viewport: { width: 1280, height: 720 }
		};
		const profile = await api('/browsers', 'POST', {
			name: 'Custom parameters',
			startUrl: fixtureBase + '/custom',
			browserOptions: options
		});
		const route = `/browsers/${profile.id}`;
		const assertOptions = (report, expected) => {
			assert.equal(report.language, expected.locale);
			assert.equal(report.languages[0], expected.locale);
			assert.equal(report.locale, expected.locale);
			assert.equal(report.timezoneId, expected.timezoneId);
			assert.equal(report.userAgent, expected.userAgent);
			assert.equal(report.headers['user-agent'], expected.userAgent);
			assert.equal(report.headers['accept-language'].split(',')[0], expected.locale);
			assert.deepEqual(report.viewport, expected.viewport);
		};
		const startAndReport = async (action = 'start') => {
			const count = reports.length;
			await api(`${route}/${action}`, 'POST');
			await until(() => reports.slice(count).some((report) => report.path === '/custom'));
			return reports.slice(count).find((report) => report.path === '/custom');
		};
		assertOptions(await startAndReport(), options);
		const busy = await fetch(base + route, { method: 'PATCH', headers, body: JSON.stringify({ browserOptions: {} }) });
		assert.equal(busy.status, 409);
		assert.equal((await busy.json()).error.code, 'BROWSER_BUSY');
		await api(`${route}/new-page`, 'POST', { url: fixtureBase + '/new-page' });
		await until(() => reports.some((report) => report.path === '/new-page'));
		assertOptions(
			reports.find((report) => report.path === '/new-page'),
			options
		);
		const defaultPage = (await api(`/browsers/${defaults.id}/pages`))[0];
		const count = reports.length;
		await api(`/browsers/${defaults.id}/reload`, 'POST', { pageId: defaultPage.id });
		await until(() => reports.slice(count).some((report) => report.path === '/defaults'));
		assert.equal(reports.slice(count).find((report) => report.path === '/defaults').language, baseline.language);
		await api(`/browsers/${defaults.id}/stop`, 'POST');
		assertOptions(await startAndReport('restart'), options);
		await api(`${route}/stop`, 'POST');
		const changed = {
			locale: 'zh-CN',
			timezoneId: 'Asia/Shanghai',
			userAgent: 'OCS changed fixture/2.0',
			viewport: { width: 1024, height: 768 }
		};
		await api(route, 'PATCH', { browserOptions: changed });
		assertOptions(await startAndReport(), changed);
		await api(`${route}/stop`, 'POST');
		await api(route, 'PATCH', { browserOptions: {} });
		const reset = await startAndReport();
		assert.equal(reset.language, baseline.language);
		assert.equal(reset.timezoneId, baseline.timezoneId);
		assert.equal(reset.userAgent, baseline.userAgent);
		assert.deepEqual(reset.viewport, baseline.viewport);
	}
);

test(
	'real HTTP: private JPEG preview reconnects, closes on stop and receives OCS configuration updates',
	{ timeout: 90000 },
	async (t) => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-http-features-'));
		const token = 'http-fixture-token-1234567890abcdef';
		const reports = [];
		let service;
		let initialNavigation;
		const html =
			'<!doctype html><html><body><h1>Private preview fixture</h1><div id="counter"></div><script>let tick=0;setInterval(async()=>{document.querySelector("#counter").textContent=String(++tick);try{const data=await fetch("http://localhost:15319/browser").then(r=>r.json());await fetch("/report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)})}catch{}},120)</script></body></html>';
		const fixture = http.createServer((req, res) => {
			if (req.url === '/report') {
				let body = '';
				req.on('data', (part) => {
					body += part;
				});
				req.on('end', () => {
					reports.push(JSON.parse(body));
					res.end('ok');
				});
				return;
			}
			res.setHeader('Content-Type', 'text/html');
			if (req.url === '/slow' && !initialNavigation) initialNavigation = res;
			else res.end(html);
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
		service = await startServer(loadConfig({ OCS_DATA_DIR: directory, OCS_AUTH_TOKEN: token, OCS_PORT: '0' }));
		const base = `http://127.0.0.1:${service.server.address().port}/api/v1`;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const api = async (route, method = 'GET', body) => {
			const response = await fetch(base + route, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			assert.equal(response.ok, true, `${method} ${route}: ${response.status} ${await response.clone().text()}`);
			return response.status === 204 ? undefined : (await response.json()).data;
		};
		await api('/settings', 'PATCH', { ocs: { openSync: true, store: { fixture: 'before' } } });
		const profile = await api('/browsers', 'POST', {
			name: 'HTTP preview',
			startUrl: `http://127.0.0.1:${fixture.address().port}/slow`
		});
		const previewUrl = `${base}/browsers/${profile.id}/preview`;
		assert.equal((await fetch(previewUrl)).status, 401);
		const stoppedPreview = await fetch(previewUrl, { headers });
		assert.equal(stoppedPreview.status, 409);
		assert.match(stoppedPreview.headers.get('content-type'), /application\/json/);
		const starting = api(`/browsers/${profile.id}/start`, 'POST');
		await until(() => initialNavigation !== undefined);
		assert.equal(service.runtime.get(profile.id).status, 'starting');
		await api('/settings', 'PATCH', { ocs: { openSync: true, store: { fixture: 'during-start' } } });
		initialNavigation.end(html);
		await starting;
		await until(() => service.runtime.get(profile.id).resources?.memoryMB > 0);
		await until(() => reports.some((report) => report.fixture === 'during-start'));
		await api('/settings', 'PATCH', { ocs: { openSync: true, store: { fixture: 'after' } } });
		await until(() => reports.some((report) => report.fixture === 'after'));
		const controller = new AbortController();
		const response = await fetch(previewUrl, { headers, signal: controller.signal });
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
		const reader = response.body.getReader();
		const frame = await firstFrame(reader);
		const busy = await fetch(previewUrl, { headers });
		assert.equal(busy.status, 409);
		controller.abort();
		await reader.cancel().catch(() => {});
		let reconnected;
		await until(async () => {
			const result = await fetch(previewUrl, { headers });
			if (result.status === 409) {
				await result.body.cancel();
				return false;
			}
			assert.equal(result.status, 200);
			reconnected = result;
			return true;
		});
		const reconnectedReader = reconnected.body.getReader();
		await firstFrame(reconnectedReader);
		await api(`/browsers/${profile.id}/stop`, 'POST');
		let ended = false;
		const drain = (async () => {
			while (!(await reconnectedReader.read()).done) {}
			ended = true;
		})();
		await until(() => ended, 5000);
		await drain;
		await api(`/browsers/${profile.id}/start`, 'POST');
		const activePage = (await api(`/browsers/${profile.id}/pages`))[0];
		const closePreview = await fetch(`${previewUrl}?pageId=${encodeURIComponent(activePage.id)}`, { headers });
		const closeReader = closePreview.body.getReader();
		await firstFrame(closeReader);
		await api(`/browsers/${profile.id}/close-page`, 'POST', { pageId: activePage.id });
		let pageStreamEnded = false;
		const closeDrain = (async () => {
			while (!(await closeReader.read()).done) {}
			pageStreamEnded = true;
		})();
		await until(() => pageStreamEnded, 5000);
		await closeDrain;
		await api(`/browsers/${profile.id}/stop`, 'POST');
		const logs = JSON.stringify(await api('/logs'));
		assert.equal(logs.includes('screencast-frame'), false);
		assert.equal(logs.includes('base64'), false);
		assert.equal(logs.includes(frame.toString('base64')), false);
		const diskLogs = fs.readFileSync(path.join(directory, 'logs', 'events.jsonl'), 'utf8');
		assert.equal(diskLogs.includes('base64'), false);
		assert.equal(diskLogs.includes('screencast-frame'), false);
	}
);
