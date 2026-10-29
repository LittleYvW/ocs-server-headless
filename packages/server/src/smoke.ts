import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import assert from 'assert/strict';
import { loadConfig } from './config';
import { startServer } from './index';

/** Real Chromium/API integration; no external websites or graphical session required. */
async function smoke() {
	delete process.env.DISPLAY;
	delete process.env.WAYLAND_DISPLAY;
	const fixture = http.createServer((req, res) => {
		if (req.url === '/download') {
			res.setHeader('Content-Disposition', 'attachment; filename="sample.txt"');
			return res.end('ocs-download-fixture');
		}
		res.setHeader('Content-Type', 'text/html');
		res.end(
			'<title>OCS smoke</title><input id="value"><button id="save" onclick="localStorage.saved=document.querySelector(\'#value\').value;document.title=localStorage.saved">Save</button><a id="download" href="/download" download="sample.txt">Download</a><script>document.title=localStorage.saved||"OCS smoke"</script>'
		);
	});
	await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
	const fixturePort = (fixture.address() as import('net').AddressInfo).port;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-smoke-'));
	const config = loadConfig({ ...process.env, OCS_DATA_DIR: dir, OCS_PORT: '0', OCS_AUTH_TOKEN: 'a'.repeat(64) });
	let service: Awaited<ReturnType<typeof startServer>> | undefined;
	try {
		service = await startServer(config);
		let port = (service.server.address() as import('net').AddressInfo).port;
		const call = async (route: string, method = 'GET', body?: unknown) => {
			const response = await fetch(`http://127.0.0.1:${port}/api/v1${route}`, {
				method,
				headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
				body: body === undefined ? undefined : JSON.stringify(body)
			});
			const json: any = await response.json();
			assert(response.ok, JSON.stringify(json));
			return json.data;
		};
		const script = await call('/user-scripts', 'POST', {
			name: 'smoke injection',
			code: 'document.querySelector("#value").value="from-script"',
			matches: [`http://127.0.0.1:${fixturePort}/*`]
		});
		const profile = await call('/browsers', 'POST', {
			name: 'smoke',
			startUrl: `http://127.0.0.1:${fixturePort}/`,
			userScriptIds: [script.id]
		});
		await call(`/browsers/${profile.id}/start`, 'POST');
		await call(`/browsers/${profile.id}/click`, 'POST', { selector: '#save' });
		assert((await call(`/browsers/${profile.id}/pages`)).some((p: any) => p.title === 'from-script'));
		await call(`/browsers/${profile.id}/fill`, 'POST', { selector: '#value', text: 'profile-persisted' });
		await call(`/browsers/${profile.id}/click`, 'POST', { selector: '#save' });
		await call(`/browsers/${profile.id}/click`, 'POST', { selector: '#download' });
		let downloads: { filename: string }[] = [];
		for (let attempt = 0; attempt < 100 && !downloads.length; attempt++) {
			downloads = await call(`/browsers/${profile.id}/downloads`);
			if (!downloads.length) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(downloads.length, 1);
		const download = await fetch(
			`http://127.0.0.1:${port}/api/v1/browsers/${profile.id}/downloads/${encodeURIComponent(downloads[0].filename)}`,
			{ headers: { Authorization: `Bearer ${config.token}` } }
		);
		assert.equal(await download.text(), 'ocs-download-fixture');
		const shot = await fetch(`http://127.0.0.1:${port}/api/v1/browsers/${profile.id}/screenshot`, {
			headers: { Authorization: `Bearer ${config.token}` }
		});
		assert.equal(shot.status, 200);
		assert.equal(
			Buffer.from(await shot.arrayBuffer())
				.subarray(0, 8)
				.toString('hex'),
			'89504e470d0a1a0a'
		);
		await service.close();
		service = await startServer(config);
		port = (service.server.address() as import('net').AddressInfo).port;
		const restored = await call(`/browsers/${profile.id}`);
		assert.equal(restored.runtime.status, 'stopped');
		await call(`/browsers/${profile.id}/start`, 'POST');
		const pages = await call(`/browsers/${profile.id}/pages`);
		assert(
			pages.some((page: any) => page.title === 'profile-persisted'),
			JSON.stringify(pages)
		);
		await call(`/browsers/${profile.id}/stop`, 'POST');
		assert.equal(service.runtime.get(profile.id).status, 'stopped');
		console.log(
			'Headless smoke passed: API, Chromium, user script, fill/click, downloads, PNG, shutdown, encrypted state reload, persistent browser storage.'
		);
	} finally {
		await service?.close();
		await new Promise<void>((resolve) => fixture.close(() => resolve()));
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

smoke().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
