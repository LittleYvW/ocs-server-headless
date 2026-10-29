const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Store } = require('../dist/store.js');

const linux = { skip: process.platform !== 'linux', timeout: 10000 };

function setup(t) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-lock-test-'));
	const children = [];
	const fixture = path.join(dir, 'owner.cjs');
	fs.writeFileSync(
		fixture,
		`const fs = require('node:fs');
const { fork } = require('node:child_process');
if (process.argv[2] === 'worker') {
  process.on('disconnect', () => {});
  setInterval(() => {}, 1000);
  process.send({ ready: true });
} else {
  const { Store } = require(process.argv[2]);
  try {
    const store = new Store(process.argv[3], process.argv[3] + '/encryption.key');
    if (process.argv[4] === 'worker') {
      const worker = fork(__filename, ['worker'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc', store.lockDescriptor] });
      worker.once('message', () => process.send({ ready: true, workerPid: worker.pid }));
    } else process.send({ ready: true });
    process.on('message', () => { store.close(); process.exit(0); });
  } catch (error) { process.send({ error: error.message }, () => process.exit(1)); }
}`
	);
	t.after(async () => {
		for (const child of children) {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			const exited = once(child, 'exit');
			child.kill('SIGKILL');
			await exited;
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const launch = (worker = false) => {
		const child = fork(fixture, [require.resolve('../dist/store.js'), dir, worker ? 'worker' : ''], {
			stdio: ['ignore', 'ignore', 'pipe', 'ipc']
		});
		children.push(child);
		return { child, result: once(child, 'message').then(([message]) => message) };
	};
	return { dir, launch };
}

test('concurrent Linux owners elect one writer and can reacquire after it exits', linux, async (t) => {
	const { dir, launch } = setup(t);
	const a = launch();
	const b = launch();
	const results = await Promise.all([a.result, b.result]);
	assert.equal(results.filter((result) => result.ready).length, 1);
	assert.match(results.find((result) => result.error).error, /already in use/);
	const owner = results[0].ready ? a.child : b.child;
	const exited = once(owner, 'exit');
	owner.send('stop');
	await exited;
	const restored = new Store(dir, path.join(dir, 'encryption.key'));
	restored.close();
});

test('Linux releases data ownership after SIGKILL without unlinking the lock file', linux, async (t) => {
	const { dir, launch } = setup(t);
	const { child, result } = launch();
	assert.equal((await result).ready, true);
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
	assert.equal(fs.existsSync(path.join(dir, 'server.lock')), true);
	const restored = new Store(dir, path.join(dir, 'encryption.key'));
	restored.close();
});

test('an inherited Linux lock blocks recovery until the remaining worker exits', linux, async (t) => {
	const { dir, launch } = setup(t);
	const { child, result } = launch(true);
	const { workerPid } = await result;
	assert.ok(workerPid);
	t.after(() => {
		try {
			process.kill(workerPid, 'SIGKILL');
		} catch {}
	});
	const exited = once(child, 'exit');
	child.kill('SIGKILL');
	await exited;
	assert.throws(() => new Store(dir, path.join(dir, 'encryption.key')), /already in use/);
	process.kill(workerPid, 'SIGKILL');
	let restored;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			restored = new Store(dir, path.join(dir, 'encryption.key'));
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.ok(restored);
	restored.close();
});

test('Linux refuses automatic takeover of a legacy PID lock', linux, (t) => {
	const { dir } = setup(t);
	fs.writeFileSync(path.join(dir, 'server.lock'), '999999');
	assert.throws(() => new Store(dir, path.join(dir, 'encryption.key')), /Legacy server.lock/);
	assert.equal(fs.readFileSync(path.join(dir, 'server.lock'), 'utf8'), '999999');
});
