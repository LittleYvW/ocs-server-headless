import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserStorage, clearBrowserStorage } from '../src/storage';

let directory: string;
let browserId: string;
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-storage-test-'));
	browserId = randomUUID();
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
function write(relative: string, content: string) {
	const file = path.join(directory, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

describe('managed browser storage', () => {
	it('counts storage and clears caches without deleting cookies or other instances', () => {
		write(`profiles/${browserId}/Default/Cache/file`, 'cache');
		write(`profiles/${browserId}/Default/Cookies`, 'cookie');
		write(`downloads/${browserId}/file`, 'download');
		write('profiles/unrelated/Default/Cookies', 'keep');
		write(`script-managers/${browserId}.json`, '[]');
		expect(browserStorage(directory, browserId)).toEqual({ profileBytes: 11, cacheBytes: 5, downloadBytes: 8 });
		clearBrowserStorage(directory, browserId, 'cache');
		expect(browserStorage(directory, browserId)).toEqual({ profileBytes: 6, cacheBytes: 0, downloadBytes: 8 });
		expect(fs.readFileSync(path.join(directory, 'profiles/unrelated/Default/Cookies'), 'utf8')).toBe('keep');
		clearBrowserStorage(directory, browserId, 'all');
		expect(fs.existsSync(path.join(directory, 'script-managers', browserId + '.json'))).toBe(false);
		expect(browserStorage(directory, browserId)).toEqual({ profileBytes: 0, cacheBytes: 0, downloadBytes: 0 });
	});
	it('rejects traversal and linked managed roots before deleting anything', () => {
		expect(() => clearBrowserStorage(directory, '../', 'all')).toThrow();
		write('outside/secret', 'protected');
		fs.mkdirSync(path.join(directory, 'profiles'), { recursive: true });
		fs.symlinkSync(
			path.join(directory, 'outside'),
			path.join(directory, 'profiles', browserId),
			process.platform === 'win32' ? 'junction' : 'dir'
		);
		expect(() => browserStorage(directory, browserId)).toThrow('symbolic links');
		expect(() => clearBrowserStorage(directory, browserId, 'all')).toThrow('symbolic links');
		expect(fs.readFileSync(path.join(directory, 'outside/secret'), 'utf8')).toBe('protected');
	});
});
