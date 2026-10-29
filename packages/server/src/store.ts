import fs from 'fs';
import path from 'path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'crypto';
import { privateFile } from './config';
import { Database } from './types';
import { DataLock } from './lock';

/** One service owns one data directory. Linux locks are released after all owners exit. */
export class Store {
	private readonly filename: string;
	private readonly lock: DataLock;
	private readonly key: Buffer;
	private data: Database;
	private closed = false;
	constructor(readonly dataDir: string, keyFile: string) {
		fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
		this.filename = path.join(dataDir, 'state.json');
		this.lock = new DataLock(dataDir);
		try {
			if (fs.existsSync(this.filename) && !fs.existsSync(keyFile)) {
				throw new Error('Encryption key missing; restore it before starting the server');
			}
			this.key = privateFile(keyFile, () => randomBytes(32));
			if (this.key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes');
			this.data = fs.existsSync(this.filename)
				? this.decrypt(fs.readFileSync(this.filename, 'utf8'))
				: { version: 1, browsers: [], userScripts: [], settings: { ocs: {} } };
			if (
				this.data.version !== 1 ||
				!Array.isArray(this.data.browsers) ||
				!Array.isArray(this.data.userScripts) ||
				!this.data.settings
			) {
				throw new Error('Unsupported or damaged state file');
			}
			if (!fs.existsSync(this.filename)) this.commit(this.data);
		} catch (error) {
			this.close();
			throw error;
		}
	}

	get lockDescriptor(): number | undefined {
		return this.lock.descriptor;
	}

	read(): Database {
		return structuredClone(this.data);
	}

	update(change: (draft: Database) => void): void {
		if (this.closed) throw new Error('Store closed');
		const draft = this.read();
		change(draft);
		this.commit(draft);
		this.data = draft;
	}

	private commit(data: Database) {
		const iv = randomBytes(12);
		const cipher = createCipheriv('aes-256-gcm', this.key, iv);
		const content = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
		const payload = JSON.stringify({
			version: 1,
			iv: iv.toString('base64'),
			tag: cipher.getAuthTag().toString('base64'),
			content: content.toString('base64')
		});
		const tmp = `${this.filename}.${randomUUID()}.tmp`;
		try {
			const fd = fs.openSync(tmp, 'wx', 0o600);
			try {
				fs.writeFileSync(fd, payload);
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(tmp, this.filename);
			if (process.platform !== 'win32') {
				const dir = fs.openSync(this.dataDir, 'r');
				try {
					fs.fsyncSync(dir);
				} finally {
					fs.closeSync(dir);
				}
			}
		} finally {
			if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
		}
	}

	private decrypt(raw: string): Database {
		const envelope = JSON.parse(raw);
		if (envelope.version !== 1) throw new Error('Unsupported state envelope');
		const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
		decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
		return JSON.parse(
			Buffer.concat([decipher.update(Buffer.from(envelope.content, 'base64')), decipher.final()]).toString()
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.lock.release();
	}
}
