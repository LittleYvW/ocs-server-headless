/**
 * Runs inside an OCS userscript as well as Node tests. Keep this function
 * self-contained: its compiled source is inserted into the installation copy.
 * Only uncompressed SFNT buffers are handled; URL/WOFF sources keep upstream behavior.
 */
export function filterFontCharacters(fontSource: unknown, chars: string | string[]): string | string[] {
	let view: DataView;
	try {
		view = ArrayBuffer.isView(fontSource)
			? new DataView(fontSource.buffer, fontSource.byteOffset, fontSource.byteLength)
			: new DataView(fontSource as ArrayBuffer);
	} catch {
		return chars;
	}
	if (view.byteLength < 4) return chars;
	const signature = view.getUint32(0);
	if (![0x00010000, 0x4f54544f, 0x74727565].includes(signature)) return chars;
	const invalid = () => new Error('OCS_FONT_CMAP_INVALID');
	const bounds = (offset: number, length: number, end = view.byteLength) => {
		if (
			!Number.isSafeInteger(offset) ||
			!Number.isSafeInteger(length) ||
			offset < 0 ||
			length < 0 ||
			offset + length > end
		)
			throw invalid();
	};
	bounds(0, 12);
	const tableCount = view.getUint16(4);
	bounds(12, tableCount * 16);
	let cmap = 0;
	let cmapEnd = 0;
	let glyphCount: number | undefined;
	for (let i = 0; i < tableCount; i++) {
		const record = 12 + i * 16;
		const tag = view.getUint32(record);
		if (tag !== 0x636d6170 && tag !== 0x6d617870) continue;
		const offset = view.getUint32(record + 8);
		const length = view.getUint32(record + 12);
		bounds(offset, length);
		if (tag === 0x636d6170) {
			cmap = offset;
			cmapEnd = offset + length;
		} else {
			if (length < 6) throw invalid();
			glyphCount = view.getUint16(offset + 4);
		}
	}
	if (!cmap) throw invalid();
	bounds(cmap, 4, cmapEnd);
	if (view.getUint16(cmap) !== 0) throw invalid();
	const encodingCount = view.getUint16(cmap + 2);
	bounds(cmap + 4, encodingCount * 8, cmapEnd);
	let subtable = 0;
	let format = 0;
	for (let i = 0; i < encodingCount; i++) {
		const record = cmap + 4 + i * 8;
		const platform = view.getUint16(record);
		const encoding = view.getUint16(record + 2);
		if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
		const offset = cmap + view.getUint32(record + 4);
		bounds(offset, 2, cmapEnd);
		const candidate = view.getUint16(offset);
		// Full-repertoire Unicode tables take precedence over BMP tables.
		if (candidate === 12 || (candidate === 4 && !format)) {
			subtable = offset;
			format = candidate;
		}
	}
	if (!format) return chars;
	const validGlyph = (glyph: number) => glyph > 0 && (glyphCount === undefined || glyph < glyphCount);
	let hasGlyph: (cp: number) => boolean;
	if (format === 4) {
		bounds(subtable, 14, cmapEnd);
		const length = view.getUint16(subtable + 2);
		bounds(subtable, length, cmapEnd);
		const end = subtable + length;
		const segmentBytes = view.getUint16(subtable + 6);
		if (segmentBytes === 0 || segmentBytes % 2) throw invalid();
		const count = segmentBytes / 2;
		const ends = subtable + 14;
		const starts = ends + segmentBytes + 2;
		const deltas = starts + segmentBytes;
		const ranges = deltas + segmentBytes;
		bounds(ranges, segmentBytes, end);
		let previous = -1;
		for (let i = 0; i < count; i++) {
			const first = view.getUint16(starts + i * 2);
			const last = view.getUint16(ends + i * 2);
			const jump = view.getUint16(ranges + i * 2);
			if (first > last || first <= previous || jump % 2) throw invalid();
			if (jump) {
				const glyphs = ranges + i * 2 + jump;
				if (glyphs < ranges + segmentBytes) throw invalid();
				bounds(glyphs, (last - first + 1) * 2, end);
			}
			previous = last;
		}
		hasGlyph = (cp) => {
			if (cp > 0xffff) return false;
			let low = 0;
			let high = count;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (view.getUint16(ends + mid * 2) < cp) low = mid + 1;
				else high = mid;
			}
			if (low === count || cp < view.getUint16(starts + low * 2)) return false;
			const delta = view.getInt16(deltas + low * 2);
			const jump = view.getUint16(ranges + low * 2);
			let glyph = cp;
			if (jump) {
				glyph = view.getUint16(ranges + low * 2 + jump + (cp - view.getUint16(starts + low * 2)) * 2);
				if (glyph === 0) return false;
			}
			return validGlyph((glyph + delta) & 0xffff);
		};
	} else {
		bounds(subtable, 16, cmapEnd);
		const length = view.getUint32(subtable + 4);
		bounds(subtable, length, cmapEnd);
		const count = view.getUint32(subtable + 12);
		const groups = subtable + 16;
		bounds(groups, count * 12, subtable + length);
		let previous = -1;
		for (let i = 0; i < count; i++) {
			const record = groups + i * 12;
			const first = view.getUint32(record);
			const last = view.getUint32(record + 4);
			if (first > last || first <= previous || last > 0x10ffff) throw invalid();
			if (view.getUint32(record + 8) + last - first > 0xffffffff) throw invalid();
			previous = last;
		}
		hasGlyph = (cp) => {
			let low = 0;
			let high = count;
			while (low < high) {
				const mid = (low + high) >>> 1;
				if (view.getUint32(groups + mid * 12 + 4) < cp) low = mid + 1;
				else high = mid;
			}
			if (low === count) return false;
			const record = groups + low * 12;
			const first = view.getUint32(record);
			return cp >= first && validGlyph(view.getUint32(record + 8) + cp - first);
		};
	}
	return Array.from(chars).filter((ch) => hasGlyph(ch.codePointAt(0) ?? -1));
}
