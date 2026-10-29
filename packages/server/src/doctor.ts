import fs from 'fs';
import os from 'os';
import path from 'path';
import { chromium, BrowserContext } from 'playwright-core';

/** Validate the actual full Chromium and sandbox without touching service data. */
export async function verifyBrowser(): Promise<void> {
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ocs-browser-check-'));
	let context: BrowserContext | undefined;
	try {
		context = await chromium.launchPersistentContext(profile, {
			channel: 'chromium',
			headless: true,
			chromiumSandbox: true,
			executablePath: process.env.OCS_BROWSER_EXECUTABLE_PATH || undefined,
			timeout: 30000
		});
		const page = context.pages()[0] || (await context.newPage());
		await page.setContent('<title>OCS browser ready</title>');
		if ((await page.title()) !== 'OCS browser ready') throw new Error('Browser rendering check failed');
	} finally {
		try {
			await context?.close();
		} finally {
			fs.rmSync(profile, { recursive: true, force: true });
		}
	}
}

if (require.main === module) {
	verifyBrowser()
		.then(() => console.log('Chromium and sandbox preflight passed.'))
		.catch((error) => {
			console.error('Chromium preflight failed:', error instanceof Error ? error.message : 'Unknown error');
			process.exitCode = 1;
		});
}
