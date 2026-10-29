import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateExtensions } from '../src/extensions';

let directory: string;
beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-extension-'));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe('configured extension manifests', () => {
	it('reports a directory named manifest.json without attempting to read it', () => {
		fs.mkdirSync(path.join(directory, 'manifest.json'));
		expect(() => validateExtensions([directory])).toThrow('manifest.json must be a regular file');
	});
	it('accepts MV3 and rejects older manifests and invalid JSON', () => {
		const filename = path.join(directory, 'manifest.json');
		fs.writeFileSync(filename, JSON.stringify({ manifest_version: 3 }));
		expect(() => validateExtensions([directory])).not.toThrow();
		fs.writeFileSync(filename, JSON.stringify({ manifest_version: 2 }));
		expect(() => validateExtensions([directory])).toThrow('Manifest V3');
		fs.writeFileSync(filename, 'invalid');
		expect(() => validateExtensions([directory])).toThrow();
	});
	it('rejects absent manifests, relative paths and ambiguous Chromium argument separators', () => {
		expect(() => validateExtensions([directory])).toThrow();
		expect(() => validateExtensions(['relative-extension'])).toThrow('Invalid extension directory');
		expect(() => validateExtensions([directory + ',other'])).toThrow('Invalid extension directory');
	});
});
