import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { isIP } from 'net';

export interface ServerConfig {
	host: string;
	port: number;
	dataDir: string;
	token: string;
	allowedOrigins: string[];
	maxBrowsers: number;
	executablePath?: string;
	extensions: string[];
	keyFile: string;
	/** Optional console build. Missing files simply fall through to API 404s. */
	webDir: string;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
	if (value === undefined) return fallback;
	if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
		throw new Error(`Expected integer between ${min} and ${max}`);
	}
	return Number(value);
}

export function privateFile(filename: string, make: () => Buffer): Buffer {
	try {
		fs.writeFileSync(filename, make(), { flag: 'wx', mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
	}
	if (process.platform !== 'win32') fs.chmodSync(filename, 0o600);
	return fs.readFileSync(filename);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
	const dataDir = path.resolve(env.OCS_DATA_DIR || './data');
	fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const host = env.OCS_HOST || '127.0.0.1';
	if (!isIP(host) && host !== 'localhost') throw new Error('OCS_HOST must be an IP address or localhost');
	const token =
		env.OCS_AUTH_TOKEN ||
		privateFile(path.join(dataDir, 'admin.token'), () => Buffer.from(randomBytes(32).toString('hex') + '\n'))
			.toString()
			.trim();
	if (token.length < 32 || /\s/.test(token))
		throw new Error('OCS_AUTH_TOKEN must contain at least 32 non-whitespace characters');
	const allowedOrigins = (env.OCS_ALLOWED_ORIGINS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const origin of allowedOrigins) {
		const url = new URL(origin);
		if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('Invalid allowed origin');
	}
	const extensions: unknown = JSON.parse(env.OCS_EXTENSIONS || '[]');
	if (!Array.isArray(extensions) || extensions.some((p) => typeof p !== 'string' || !path.isAbsolute(p))) {
		throw new Error('OCS_EXTENSIONS must be a JSON array of absolute paths');
	}
	return {
		host,
		port: integer(env.OCS_PORT, 15319, 0, 65535),
		dataDir,
		token,
		allowedOrigins,
		maxBrowsers: integer(env.OCS_MAX_BROWSERS, 4, 1, 64),
		executablePath: env.OCS_BROWSER_EXECUTABLE_PATH || undefined,
		extensions: extensions as string[],
		keyFile: path.resolve(env.OCS_ENCRYPTION_KEY_FILE || path.join(dataDir, 'encryption.key')),
		webDir: path.resolve(env.OCS_WEB_DIR || path.join(__dirname, '..', 'web'))
	};
}
