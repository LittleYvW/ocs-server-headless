import { describe, expect, it } from 'vitest';
import { filterFontCharacters } from '../src/font-cmap';

const { sfnt, format4, format12 } = require('./fixtures/font-cmap.cjs');

describe('font cmap coverage', () => {
	it('keeps mapped format 4 characters and excludes ordinary text, .notdef and unmapped codepoints', () => {
		expect(filterFontCharacters(sfnt(), '国A墿B题C错😀\uffff')).toEqual(['墿', 'B', 'C']);
	});
	it('supports typed-array slices without reading neighboring bytes', () => {
		const font = sfnt();
		const allocation = new Uint8Array(font.length + 20);
		allocation.set(font, 7);
		expect(filterFontCharacters(allocation.subarray(7, 7 + font.length), ['国', '墿', 'A', 'B'])).toEqual(['墿', 'B']);
	});
	it('handles format 12 supplementary characters and glyph zero', () => {
		const font = sfnt([{ data: format12(), platform: 3, encoding: 10 }]);
		expect(filterFontCharacters(font, '国墿😀😁题')).toEqual(['墿', '😁']);
	});
	it('prefers a full Unicode table and ignores non-Unicode encodings', () => {
		const font = sfnt([
			{ data: format4(), platform: 3, encoding: 1 },
			{ data: format12(), platform: 0, encoding: 4 }
		]);
		expect(filterFontCharacters(font, 'B墿😁')).toEqual(['墿', '😁']);
		const nonUnicode = sfnt([{ data: format4(), platform: 3, encoding: 2 }]);
		expect(filterFontCharacters(nonUnicode, '国墿')).toBe('国墿');
	});
	it('leaves URL and compressed font inputs to the upstream implementation', () => {
		const chars = ['国', '墿'];
		expect(filterFontCharacters('https://fonts.test/font.woff2', chars)).toBe(chars);
		expect(filterFontCharacters(Buffer.from('wOF2fixture'), chars)).toBe(chars);
	});
	it('rejects damaged SFNT bounds and glyph offsets before a mapping can be produced', () => {
		const truncated = sfnt().subarray(0, 40);
		expect(() => filterFontCharacters(truncated, '国墿')).toThrow('OCS_FONT_CMAP_INVALID');
		const invalidOffset = sfnt();
		invalidOffset.writeUInt16BE(0xfffe, 28 + 12 + 34);
		expect(() => filterFontCharacters(invalidOffset, '国墿')).toThrow('OCS_FONT_CMAP_INVALID');
		const invalidGroup = format12();
		invalidGroup.writeUInt32BE(0x110000, 32);
		expect(() => filterFontCharacters(sfnt([{ data: invalidGroup, platform: 3, encoding: 10 }]), '国墿')).toThrow(
			'OCS_FONT_CMAP_INVALID'
		);
	});
});
