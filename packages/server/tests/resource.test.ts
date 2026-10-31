import { describe, it, expect } from 'vitest';
import { evaluateResourceCapacity, hostResources, processMemoryMB, ResourceSampler } from '../src/resource';
import type { BrowserContext } from 'playwright-core';

describe('resource reporting and startup thresholds', () => {
	it('rejects insufficient resources only when a threshold is configured', () => {
		const host = { totalMemoryMB: 4096, freeMemoryMB: 300, cpuCount: 4, loadAverage: [0, 0, 0], cpuPercent: 95 };
		expect(() => evaluateResourceCapacity({}, host)).not.toThrow();
		expect(() => evaluateResourceCapacity({ minFreeMemoryMB: 512 }, host)).toThrow('memory');
		expect(() => evaluateResourceCapacity({ maxCpuPercent: 90 }, host)).toThrow('CPU');
		expect(() => evaluateResourceCapacity({ minFreeMemoryMB: 200, maxCpuPercent: 99 }, host)).not.toThrow();
		expect(hostResources().cpuCount).toBeGreaterThan(0);
		expect(hostResources().totalMemoryMB).toBeGreaterThan(0);
	});
	it('counts real resident memory and ignores invalid or exited PIDs', async () => {
		expect(await processMemoryMB([])).toBe(0);
		expect(await processMemoryMB([-1, NaN, 1.5])).toBe(0);
		expect(await processMemoryMB([process.pid])).toBeGreaterThan(0);
	});
	it('detaches CDP sessions after successful and failed sampling', async () => {
		let detached = 0;
		let fail = false;
		const context = {
			browser: () => ({
				newBrowserCDPSession: async () => ({
					send: async () => {
						if (fail) throw new Error('closed');
						return { processInfo: [{ id: process.pid, cpuTime: 1 }] };
					},
					detach: async () => {
						detached++;
					}
				})
			})
		} as unknown as BrowserContext;
		const sampler = new ResourceSampler();
		const first = await sampler.sample(context);
		expect(first.memoryMB).toBeGreaterThan(0);
		expect(first.cpuPercent).toBe(0);
		fail = true;
		await expect(sampler.sample(context)).rejects.toThrow('closed');
		expect(detached).toBe(2);
	});
});
