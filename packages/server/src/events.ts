import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export interface ServiceEvent {
	id: number;
	type: string;
	time: string;
	data: unknown;
}

export class Events extends EventEmitter {
	private entries: ServiceEvent[] = [];
	private sequence = 0;
	private readonly logfile: string;
	constructor(dataDir: string) {
		super();
		this.setMaxListeners(70);
		const logs = path.join(dataDir, 'logs');
		fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
		this.logfile = path.join(logs, 'events.jsonl');
	}

	publish(type: string, data: unknown): void {
		const event: ServiceEvent = { id: ++this.sequence, type, time: new Date().toISOString(), data };
		this.entries.push(event);
		if (this.entries.length > 500) this.entries.shift();
		try {
			if (fs.existsSync(this.logfile) && fs.statSync(this.logfile).size > 5 * 1024 * 1024) {
				fs.renameSync(this.logfile, this.logfile + '.1');
			}
			fs.appendFileSync(this.logfile, JSON.stringify(event) + '\n', { mode: 0o600 });
		} catch {
			process.stderr.write('Event log write failed\n');
		}
		this.emit('event', event);
	}

	list(limit = 100): ServiceEvent[] {
		return this.entries.slice(-limit);
	}
}
