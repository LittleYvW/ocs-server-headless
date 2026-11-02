import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { adaptOCSFontSource, OCS_FONT_FIX_MARKER } from '../src/ocs-font-fix';
import { installationCode } from '../src/manager';
import { parseUserScriptMetadata } from '../src/userscript-source';

const { sfnt, header, decoder } = require('./fixtures/font-cmap.cjs');
const adapt = (code: string) => adaptOCSFontSource(code, parseUserScriptMetadata(code)!);

describe('OCS font installation repair', () => {
	it.each([false, true])('filters input before the decoder selects its worker path (%s)', async (useWorker) => {
		const source = header + decoder;
		const installed = installationCode({ code: source });
		const context: any = { FontFace: class {}, URL };
		new Script(installed).runInNewContext(context);
		const decode = context.decodeFixture;
		const result = await decode(sfnt(), '国A墿B题', { refTableUrl: '', useWorker });
		expect([...result.chars]).toEqual(['墿', 'B']);
		expect(result.strict).toBe(true);
		expect(source).not.toContain(OCS_FONT_FIX_MARKER);
		expect(parseUserScriptMetadata(installed)?.values.version).toEqual(['5.2.6']);
	});
	it('handles renamed functions and parameters without relying on bundle formatting', async () => {
		const renamed = decoder
			.replace(/\bdecoder\b/g, 'd')
			.replace(/\bfontSource\b/g, 'a')
			.replace(/\bchars\b/g, 'b')
			.replace(/\bconfig\b/g, 'c')
			.replace(/\bcovered\b/g, 'g')
			.replace(/\s+/g, ' ');
		const result = adapt(header + renamed);
		expect(result.fontFix).toBe('applied');
		const context: any = { FontFace: class {} };
		new Script(result.code).runInNewContext(context);
		const decode = context.decodeFixture;
		expect([...(await decode(sfnt(), '国墿', { useWorker: true })).b]).toEqual(['墿']);
	});
	it('is idempotent and does not rewrite unrelated scripts or function-looking strings', () => {
		const patched = adapt(header + decoder);
		expect(adapt(patched.code)).toEqual(patched);
		const other = header.replace('OCS font fixture', 'Other helper') + decoder;
		expect(adapt(other)).toEqual({ code: other, fontFix: 'not-needed' });
		const literal = header + 'const example = ' + JSON.stringify(decoder);
		expect(adapt(literal)).toEqual({ code: literal, fontFix: 'not-needed' });
	});
	it('reports unknown vulnerable layouts while preserving their source', () => {
		const unknown = header + decoder.replace('config.useWorker', 'config.changedOption');
		expect(adapt(unknown)).toEqual({ code: unknown, fontFix: 'unrecognized' });
		const fixed = header + decoder.replace('return diff < 1000', 'return false');
		expect(adapt(fixed)).toEqual({ code: fixed, fontFix: 'not-needed' });
	});
	it('accepts manager-wrapped userscripts with a top-level early return', () => {
		const result = adapt(header + decoder + '\nif (false) return;');
		expect(result.fontFix).toBe('applied');
		expect(() => new Script(`(function() {\n${result.code}\n})();`)).not.toThrow();
	});
	it('composes with the private GM bridge and leaves the imported object untouched', async () => {
		const source = { code: header.replace('// @grant none', '// @grant GM_xmlhttpRequest') + decoder };
		const original = source.code;
		const installed = installationCode(source, 'http://127.0.0.1:54321/private/');
		expect(source.code).toBe(original);
		expect(installed).toContain('http://127.0.0.1:54321/private/');
		const context: any = { FontFace: class {}, URL, GM_xmlhttpRequest: () => {} };
		new Script(installed).runInNewContext(context);
		const decode = context.decodeFixture;
		expect([...(await decode(sfnt(), '国墿', { useWorker: true })).chars]).toEqual(['墿']);
	});
});
