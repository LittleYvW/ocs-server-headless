import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Validate explicitly configured extensions before passing them to Chromium. */
export function validateExtensions(extensions: string[]): void {
	for (const directory of extensions) {
		if (!path.isAbsolute(directory) || directory.includes(',')) throw new Error('Invalid extension directory');
		const filename = path.join(directory, 'manifest.json');
		if (!statSync(filename).isFile()) throw new Error('Extension manifest.json must be a regular file');
		const manifest = JSON.parse(readFileSync(filename, 'utf8'));
		if (manifest?.manifest_version !== 3) throw new Error('Only unpacked Manifest V3 extensions are supported');
	}
}
