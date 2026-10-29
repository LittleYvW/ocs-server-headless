import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const HEADER = 'ocs-flock-v1\n';

/** Linux keeps a kernel lock on an open file description, including worker copies. */
export class DataLock {
	readonly descriptor?: number;
	private readonly filename: string;
	private released = false;

	constructor(dataDir: string) {
		this.filename = path.join(dataDir, 'server.lock');
		if (process.platform !== 'linux') {
			try {
				fs.writeFileSync(this.filename, String(process.pid), { flag: 'wx', mode: 0o600 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
				throw new Error('Data directory already in use or server.lock remains after a crash; verify its owner');
			}
			return;
		}

		const fd = fs.openSync(this.filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
		try {
			const result = spawnSync('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'], {
				stdio: ['ignore', 'pipe', 'pipe', fd]
			});
			if (result.status === 73) throw new Error('Data directory already in use');
			if (result.error || result.status !== 0) {
				throw new Error(
					'Cannot acquire Linux data lock; install flock from util-linux and use a local data filesystem'
				);
			}
			const content = fs.readFileSync(fd, 'utf8');
			if (content && content !== HEADER) {
				throw new Error(
					'Legacy server.lock found; stop the old service and verify its workers before removing it once'
				);
			}
			fs.fchmodSync(fd, 0o600);
			fs.ftruncateSync(fd, 0);
			fs.writeSync(fd, HEADER, 0, 'utf8');
			fs.fsyncSync(fd);
			this.descriptor = fd;
		} catch (error) {
			fs.closeSync(fd);
			throw error;
		}
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		if (this.descriptor !== undefined) {
			// Keep this inode in place. Unlinking a held flock allows a second writer.
			fs.closeSync(this.descriptor);
		} else {
			fs.unlinkSync(this.filename);
		}
	}
}
