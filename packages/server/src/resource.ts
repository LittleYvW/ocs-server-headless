import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import type { BrowserContext } from 'playwright-core';
import { ApiError } from './validation';

export interface BrowserResources {
	memoryMB: number;
	cpuPercent: number;
	cpuTime: number;
	pids: number[];
}

export interface HostResources {
	totalMemoryMB: number;
	freeMemoryMB: number;
	cpuCount: number;
	loadAverage: number[];
	cpuPercent?: number;
}

export interface ResourcePolicy {
	minFreeMemoryMB?: number;
	maxCpuPercent?: number;
}

export function hostResources(): HostResources {
	return {
		totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
		freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
		cpuCount: os.cpus().length,
		loadAverage: os.loadavg()
	};
}

function cpuSample() {
	return os.cpus().reduce(
		(sum, cpu) => ({
			idle: sum.idle + cpu.times.idle,
			total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0)
		}),
		{ idle: 0, total: 0 }
	);
}

export function evaluateResourceCapacity(policy: ResourcePolicy, resources: HostResources): void {
	if (policy.minFreeMemoryMB && resources.freeMemoryMB < policy.minFreeMemoryMB) {
		throw new ApiError(409, 'RESOURCE_LIMIT', 'Available memory is below the configured startup threshold');
	}
	if (policy.maxCpuPercent && resources.cpuPercent !== undefined && resources.cpuPercent > policy.maxCpuPercent) {
		throw new ApiError(409, 'RESOURCE_LIMIT', 'CPU usage is above the configured startup threshold');
	}
}

/** Disabled thresholds have no sampling cost. Both checks apply before allocating a new worker. */
export async function checkResourceCapacity(policy: ResourcePolicy): Promise<void> {
	const resources = hostResources();
	evaluateResourceCapacity(policy, resources);
	if (policy.maxCpuPercent) {
		const before = cpuSample();
		await new Promise((resolve) => setTimeout(resolve, 200));
		const after = cpuSample();
		const elapsed = after.total - before.total;
		resources.cpuPercent = elapsed > 0 ? Math.max(0, (1 - (after.idle - before.idle) / elapsed) * 100) : 0;
		evaluateResourceCapacity(policy, resources);
	}
}

function command(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/** Only validated numeric PIDs enter system commands; symlinks and browser-supplied paths are never read. */
export async function processMemoryMB(input: number[]): Promise<number> {
	const pids = [...new Set(input.filter((pid) => Number.isSafeInteger(pid) && pid > 0))].slice(0, 4096);
	if (!pids.length) return 0;
	if (process.platform === 'linux') {
		const memory = await Promise.all(
			pids.map(async (pid) => {
				try {
					const status = await readFile(`/proc/${pid}/status`, 'utf8');
					return Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] || 0);
				} catch {
					return 0; // Processes may exit between the CDP and OS snapshots.
				}
			})
		);
		return Math.round((memory.reduce((a, b) => a + b, 0) / 1024) * 10) / 10;
	}
	if (process.platform === 'darwin') {
		const output = await command('ps', ['-o', 'rss=', '-p', pids.join(',')]);
		return Math.round((output.split('\n').reduce((sum, line) => sum + (Number(line.trim()) || 0), 0) / 1024) * 10) / 10;
	}
	if (process.platform === 'win32') {
		const output = await command('powershell.exe', [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			`(Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`
		]);
		return Math.round(((Number(output.trim()) || 0) / 1024 / 1024) * 10) / 10;
	}
	return 0;
}

/** Own one sampler per browser; samples are serialized by the worker's reporting loop. */
export class ResourceSampler {
	private previous?: { time: number; cpuTime: number };
	async sample(context: BrowserContext): Promise<BrowserResources> {
		const browser = context.browser();
		if (!browser) throw new Error('Browser resources are unavailable');
		const session = await browser.newBrowserCDPSession();
		let infos: { id: number; cpuTime: number }[];
		try {
			const result = await session.send('SystemInfo.getProcessInfo');
			infos = result.processInfo;
		} finally {
			await session.detach().catch(() => {});
		}
		const pids = infos.map((item) => item.id);
		const cpuTime = infos.reduce((sum, item) => sum + (Number(item.cpuTime) || 0), 0);
		const now = performance.now();
		const elapsed = this.previous ? (now - this.previous.time) / 1000 : 0;
		const cpuPercent =
			this.previous && elapsed > 0 ? Math.max(0, ((cpuTime - this.previous.cpuTime) / elapsed) * 100) : 0;
		this.previous = { time: now, cpuTime };
		return { memoryMB: await processMemoryMB(pids), cpuPercent: Math.round(cpuPercent * 10) / 10, cpuTime, pids };
	}
}
