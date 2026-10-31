import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Script } from 'node:vm';
import { extractManagerArchive, installationCode } from '../src/manager';
import { parseUserScriptMetadata } from '../src/userscript-source';

const temporary: string[] = [];
const directory = () => {
	const result = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-archive-test-'));
	temporary.push(result);
	return result;
};
afterEach(() => {
	for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});

describe('script manager archives', () => {
	it('extracts a root MV3 extension as regular files', () => {
		const root = directory();
		const archive = zipSync({
			'manifest.json': strToU8(JSON.stringify({ manifest_version: 3, name: 'fixture', version: '1.0' })),
			'src/worker.js': strToU8('void 0')
		});
		extractManagerArchive(archive, root);
		expect(fs.readFileSync(path.join(root, 'src/worker.js'), 'utf8')).toBe('void 0');
	});
	it('rejects traversal and platform-specific absolute paths before writing', () => {
		for (const name of ['../escaped.js', '/absolute.js', 'C:/absolute.js', 'dir\\escaped.js']) {
			const root = directory();
			expect(() =>
				extractManagerArchive(zipSync({ 'manifest.json': strToU8('{}'), [name]: strToU8('void 0') }), root)
			).toThrow();
			expect(fs.readdirSync(root)).toEqual([]);
		}
	});
	it('rejects incomplete and legacy extensions', () => {
		expect(() => extractManagerArchive(zipSync({ 'src/worker.js': strToU8('void 0') }), directory())).toThrow(
			'root manifest'
		);
		expect(() =>
			extractManagerArchive(zipSync({ 'manifest.json': strToU8('{"manifest_version":2}') }), directory())
		).toThrow('Manifest V3');
	});
});

describe('managed installation copies', () => {
	it('disables manager auto-updates while retaining the original source and version', () => {
		const code =
			'// ==UserScript==\n// @name fixture\n// @version 1.2\n// @updateURL https://source.test/latest.meta.js\n// @downloadURL https://source.test/latest.user.js\n// ==/UserScript==\nvoid 0';
		const installed = installationCode({ code });
		expect(parseUserScriptMetadata(installed)?.values).toMatchObject({
			updateURL: ['none'],
			downloadURL: ['none'],
			version: ['1.2']
		});
		expect(code).toContain('@updateURL https://source.test/latest.meta.js');
	});
	it('adapts only OCS loopback reads for both GM APIs, including a frozen modern API', () => {
		const calls: string[] = [];
		const request = (input: { url: string }) => {
			calls.push(input.url);
		};
		const code =
			'// ==UserScript==\n// @name fixture\n// @grant GM_xmlhttpRequest\n// @grant GM.xmlHttpRequest\n// ==/UserScript==\n' +
			'GM_xmlhttpRequest({url:"http://localhost:15319/browser?x=1"});' +
			'GM.xmlHttpRequest({url:"http://127.0.0.1:15319/get-actions-key"});' +
			'GM.xmlHttpRequest({url:"https://source.test/browser"});' +
			'GM_xmlhttpRequest({url:"http://localhost:15319/browser-other"});';
		new Script(installationCode({ code }, 'http://127.0.0.1:54321/private/')).runInNewContext({
			URL,
			GM_xmlhttpRequest: request,
			GM: Object.freeze({ xmlHttpRequest: request, getValue: () => 'preserved' })
		});
		expect(calls).toEqual([
			'http://127.0.0.1:54321/private/browser?x=1',
			'http://127.0.0.1:54321/private/get-actions-key',
			'https://source.test/browser',
			'http://localhost:15319/browser-other'
		]);
	});
});
