import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ApiError, fields, id, missing, object } from './validation';
import type { Store } from './store';
import type { Events } from './events';
import type { RuntimeState } from './types';

const CACHE_DIRECTORIES = [
	'Default/Cache',
	'Default/Code Cache',
	'Default/GPUCache',
	'Default/Service Worker/CacheStorage',
	'ShaderCache',
	'GrShaderCache',
	'GraphiteDawnCache',
	'DawnGraphiteCache'
];

interface StorageRuntime {
	get(id: string): RuntimeState;
}

/** Resolve fixed managed paths and refuse symlinks at every component below the data directory. */
function managedPath(dataDir: string, relative: string): string {
	const root = path.resolve(dataDir);
	const target = path.resolve(root, relative);
	if (target === root || !target.startsWith(root + path.sep))
		throw new ApiError(400, 'INVALID_STORAGE_PATH', 'Invalid storage path');
	let directory = root;
	for (const component of path.relative(root, target).split(path.sep)) {
		directory = path.join(directory, component);
		if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink())
			throw new ApiError(409, 'UNSAFE_STORAGE_PATH', 'Managed storage must not contain symbolic links');
	}
	return target;
}

function directoryBytes(directory: string): number {
	if (!fs.existsSync(directory)) return 0;
	const queue = [{ directory, depth: 0 }];
	let bytes = 0;
	let visited = 0;
	while (queue.length) {
		const entry = queue.pop()!;
		if (++visited > 200000 || entry.depth > 64)
			throw new ApiError(413, 'STORAGE_TOO_COMPLEX', 'Storage directory is too large to inspect');
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(entry.directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		if (stat.isSymbolicLink()) continue;
		if (stat.isFile()) bytes += stat.size;
		else if (stat.isDirectory()) {
			for (const child of fs.readdirSync(entry.directory))
				queue.push({ directory: path.join(entry.directory, child), depth: entry.depth + 1 });
		}
	}
	return bytes;
}

export function browserStorage(dataDir: string, browserId: string) {
	id(browserId);
	const profilePath = managedPath(dataDir, path.join('profiles', browserId));
	const downloadPath = managedPath(dataDir, path.join('downloads', browserId));
	const cachePaths = CACHE_DIRECTORIES.map((directory) =>
		managedPath(dataDir, path.join('profiles', browserId, directory))
	);
	return {
		profileBytes: directoryBytes(profilePath),
		downloadBytes: directoryBytes(downloadPath),
		cacheBytes: cachePaths.reduce((sum, directory) => sum + directoryBytes(directory), 0)
	};
}

export function clearBrowserStorage(
	dataDir: string,
	browserId: string,
	target: 'cache' | 'profile' | 'downloads' | 'all'
): void {
	id(browserId);
	if (!['cache', 'profile', 'downloads', 'all'].includes(target))
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid storage target');
	const relatives =
		target === 'cache'
			? CACHE_DIRECTORIES.map((directory) => path.join('profiles', browserId, directory))
			: target === 'all'
			? [path.join('profiles', browserId), path.join('downloads', browserId), path.join('download-staging', browserId)]
			: [path.join(target === 'profile' ? 'profiles' : 'downloads', browserId)];
	if (target === 'profile' || target === 'all') relatives.push(path.join('script-managers', browserId + '.json'));
	// Validate all selected paths before the first removal. Paths are fixed beneath this profile.
	const targets = relatives.map((relative) => managedPath(dataDir, relative));
	for (const directory of targets) fs.rmSync(directory, { recursive: true, force: true });
}

/** Mount at /api/v1/browsers, after the shared authentication middleware. */
export function createStorageRouter(store: Store, runtime: StorageRuntime, events: Events): Router {
	const router = Router();
	const browserId = (value: string) => {
		if (!store.read().browsers.some((browser) => browser.id === id(value))) return missing();
		return value;
	};
	router.get('/:id/storage', (req, res, next) => {
		try {
			res.json({ data: browserStorage(store.dataDir, browserId(req.params.id)) });
		} catch (error) {
			next(error);
		}
	});
	router.delete('/:id/storage', (req, res, next) => {
		try {
			const profileId = browserId(req.params.id);
			const body = object(req.body);
			fields(body, ['target']);
			if (!['cache', 'profile', 'downloads', 'all'].includes(body.target))
				throw new ApiError(400, 'INVALID_REQUEST', 'Invalid storage target');
			const state = runtime.get(profileId);
			if (state.pid !== undefined || ['starting', 'running', 'stopping'].includes(state.status))
				throw new ApiError(409, 'BROWSER_BUSY', 'Stop the browser before clearing its storage');
			// Synchronous removal keeps the stopped-state check and mutation in one event-loop turn.
			clearBrowserStorage(store.dataDir, profileId, body.target);
			events.publish('browser.storage-cleared', { profileId, target: body.target });
			res.json({ data: browserStorage(store.dataDir, profileId) });
		} catch (error) {
			next(error);
		}
	});
	return router;
}
