const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../dist/runtime.js');

function setup(t, overrides = {}) {
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-runtime-'));
	const workerPath = path.join(dataDir, 'fake-worker.cjs');
	fs.writeFileSync(
		workerPath,
		`let mode = '';
		process.on('SIGTERM', () => { if (mode !== 'hang-stop') process.exit(0); });
		process.on('message', message => {
			if (message.action === 'start') {
				mode = message.payload.profile.name;
				if (mode === 'hang-start') return;
				if (mode === 'fail-start') return process.send({ id: message.id, ok: false, error: 'Start failed', code: 'FAILED', status: 502 });
				return process.send({ id: message.id, ok: true });
			}
			if (message.action === 'stop') {
				if (mode === 'graceful-stop') {
					setTimeout(() => { require('node:fs').writeFileSync(__dirname + '/flushed', 'yes'); process.exit(0); }, 30);
					return;
				}
				if (mode !== 'hang-stop') process.exit(0);
				return;
			}
			if (mode === 'crash') process.exit(1);
			else if (mode !== 'hang-command') process.send({ id: message.id, ok: true, result: [{ id: 'page-1', url: 'about:blank', title: '' }] });
		});`
	);
	const events = [];
	const runtime = new Runtime(
		{
			dataDir,
			workerPath,
			maxBrowsers: 1,
			extensions: [],
			startupTimeoutMs: 3000,
			stopTimeoutMs: 150,
			commandTimeoutMs: 150,
			...overrides
		},
		(type, data) => events.push({ type, data })
	);
	t.after(async () => {
		await runtime.close();
		fs.rmSync(dataDir, { recursive: true, force: true });
	});
	return { runtime, events, dataDir };
}

function profile(id = 'browser-1', name = 'normal') {
	return { id, name, startUrl: 'about:blank', automationScripts: [], userScriptIds: [], createdAt: '', updatedAt: '' };
}

test('reserves a profile before spawning, limits concurrent browsers, restarts and stops', async (t) => {
	const { runtime, events } = setup(t);
	const startup = runtime.start(profile(), []);
	await assert.rejects(runtime.start(profile(), []), { code: 'BROWSER_BUSY' });
	await assert.rejects(runtime.start(profile('browser-2'), []), { code: 'BROWSER_LIMIT' });
	assert.equal((await startup).status, 'running');
	const pid = runtime.get('browser-1').pid;
	assert.ok(pid);
	assert.equal((await runtime.command('browser-1', 'pages')).length, 1);
	assert.equal((await runtime.restart(profile(), [])).status, 'running');
	assert.notEqual(runtime.get('browser-1').pid, pid);
	assert.equal((await runtime.stop('browser-1')).status, 'stopped');
	assert.equal((await runtime.stop('browser-1')).status, 'stopped');
	assert.ok(events.some(({ data }) => data.status === 'running' && data.profileId === 'browser-1'));
	await assert.rejects(runtime.command('browser-1', 'pages'), { code: 'BROWSER_NOT_RUNNING' });
});

test('stop cancels a pending launch and releases the concurrency slot', async (t) => {
	const { runtime } = setup(t);
	const startup = runtime.start(profile('browser-1', 'hang-start'), []);
	const rejectedStartup = assert.rejects(startup, { code: 'BROWSER_STOPPING' });
	assert.equal((await runtime.stop('browser-1')).status, 'stopped');
	await rejectedStartup;
	assert.equal((await runtime.start(profile('browser-2'), [])).status, 'running');
});

test('failed startup cleans up the worker and allows a retry', async (t) => {
	const { runtime } = setup(t);
	await assert.rejects(runtime.start(profile('browser-1', 'fail-start'), []), { code: 'FAILED' });
	assert.equal(runtime.get('browser-1').status, 'error');
	assert.equal(runtime.get('browser-1').pid, undefined);
	assert.equal((await runtime.start(profile(), [])).status, 'running');
});

test('startup timeout terminates a stuck launch and releases its slot', async (t) => {
	const { runtime } = setup(t, { startupTimeoutMs: 200 });
	await assert.rejects(runtime.start(profile('browser-1', 'hang-start'), []), { code: 'BROWSER_TIMEOUT' });
	assert.equal(runtime.get('browser-1').status, 'error');
	assert.equal(runtime.get('browser-1').pid, undefined);
	assert.equal((await runtime.start(profile('browser-2'), [])).status, 'running');
});

test('an unresponsive worker is killed during stop', async (t) => {
	const { runtime } = setup(t);
	await runtime.start(profile('browser-1', 'hang-stop'), []);
	const pid = runtime.get('browser-1').pid;
	await runtime.stop('browser-1');
	assert.equal(runtime.get('browser-1').status, 'stopped');
	assert.throws(() => process.kill(pid, 0));
});

test('stop waits for the worker to flush data before sending termination signals', async (t) => {
	const { runtime, dataDir } = setup(t);
	await runtime.start(profile('browser-1', 'graceful-stop'), []);
	await runtime.stop('browser-1');
	assert.equal(fs.readFileSync(path.join(dataDir, 'flushed'), 'utf8'), 'yes');
});

test('worker exit rejects commands and records an error without leaking arguments', async (t) => {
	const { runtime } = setup(t);
	await runtime.start(profile('browser-1', 'crash'), []);
	await assert.rejects(runtime.command('browser-1', 'fill', { selector: '#password', text: 'private-password' }));
	assert.equal(runtime.get('browser-1').status, 'error');
	assert.ok(!JSON.stringify(runtime.list()).includes('private-password'));
});

test('command timeouts do not leave pending requests and shutdown prevents new launches', async (t) => {
	const { runtime } = setup(t);
	await runtime.start(profile('browser-1', 'hang-command'), []);
	await assert.rejects(runtime.command('browser-1', 'pages'), { code: 'BROWSER_TIMEOUT' });
	await runtime.close();
	await assert.rejects(runtime.start(profile(), []), { code: 'SHUTTING_DOWN' });
});

test('rejects browser IDs that could escape the profile root', async (t) => {
	const { runtime } = setup(t);
	await assert.rejects(runtime.start(profile('../escape'), []), { code: 'INVALID_ID' });
});
