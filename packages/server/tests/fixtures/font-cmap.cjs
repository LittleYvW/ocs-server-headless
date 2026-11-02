// Small synthetic SFNT buffers: no course content, third-party glyphs or credentials.
const encryptedCodepoint = '墿'.codePointAt(0);

function format4() {
	const table = Buffer.alloc(46);
	table.writeUInt16BE(4, 0);
	table.writeUInt16BE(table.length, 2);
	table.writeUInt16BE(6, 6);
	[0x43, encryptedCodepoint, 0xffff].forEach((value, i) => table.writeUInt16BE(value, 14 + i * 2));
	[0x41, encryptedCodepoint, 0xffff].forEach((value, i) => table.writeUInt16BE(value, 22 + i * 2));
	[1, (1 - encryptedCodepoint) & 0xffff, 1].forEach((value, i) => table.writeUInt16BE(value, 28 + i * 2));
	table.writeUInt16BE(6, 34);
	// A maps to .notdef; B/C map through the glyph array and idDelta.
	[0, 1, 2].forEach((value, i) => table.writeUInt16BE(value, 40 + i * 2));
	return table;
}

function format12() {
	const table = Buffer.alloc(40);
	table.writeUInt16BE(12, 0);
	table.writeUInt32BE(table.length, 4);
	table.writeUInt32BE(2, 12);
	[encryptedCodepoint, encryptedCodepoint, 1, 0x1f600, 0x1f601, 0].forEach((value, i) =>
		table.writeUInt32BE(value, 16 + i * 4)
	);
	return table;
}

function sfnt(tables = [{ data: format4(), platform: 3, encoding: 1 }]) {
	const headerLength = 4 + tables.length * 8;
	const cmapLength = headerLength + tables.reduce((sum, table) => sum + table.data.length, 0);
	const font = Buffer.alloc(28 + cmapLength);
	font.writeUInt32BE(0x00010000, 0);
	font.writeUInt16BE(1, 4);
	font.write('cmap', 12, 'ascii');
	font.writeUInt32BE(28, 20);
	font.writeUInt32BE(cmapLength, 24);
	font.writeUInt16BE(tables.length, 30);
	let offset = headerLength;
	tables.forEach((table, i) => {
		font.writeUInt16BE(table.platform, 32 + i * 8);
		font.writeUInt16BE(table.encoding, 34 + i * 8);
		font.writeUInt32BE(offset, 36 + i * 8);
		table.data.copy(font, 28 + offset);
		offset += table.data.length;
	});
	return font;
}

const header = `// ==UserScript==
// @name OCS font fixture
// @namespace https://enncy.cn
// @source https://github.com/ocsjs/ocsjs
// @version 5.2.6
// @grant none
// ==/UserScript==
`;

// A reduced decoder boundary used to exercise installation-copy adaptation.
// The faulty pixel check deliberately considers every character covered.
const decoder = `
const secretFamily = 'font-cxsecret';
function covered(family, ch) {
  const render = fallback => ({ getImageData() { return [fallback]; } }).getImageData();
  render('serif'); render('sans-serif');
  const diff = 0;
  return diff < 1000;
}
async function decoder(fontSource, chars, config) {
  'use strict';
  const table = config.refTableUrl;
  if (config.useWorker) return { chars, strict: this === undefined };
  const family = 'font-decrypt-' + Math.random();
  const face = false ? new FontFace(family, fontSource) : null;
  if (!covered(family, '国')) throw new Error('fixture coverage');
  return { chars, strict: this === undefined };
}
globalThis.decodeFixture = decoder;
`;

module.exports = { format4, format12, sfnt, header, decoder };
