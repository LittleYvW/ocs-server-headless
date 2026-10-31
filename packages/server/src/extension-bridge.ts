import http from 'node:http';
import { randomBytes } from 'node:crypto';

// GM requests bypass page routes. The installation copy sends the three legacy
// OCS reads to a private per-instance endpoint; the database keeps original code.
export async function createExtensionBridge(readConfig: () => Record<string, unknown>, token: string) {
	const secret = randomBytes(32).toString('hex');
	const paths = new Set(['browser', 'is-browser-config-sync', 'get-actions-key']);
	const server = http.createServer((request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		response.setHeader('X-Content-Type-Options', 'nosniff');
		const route = request.url?.split('?')[0] || '';
		const name = route.startsWith('/' + secret + '/') ? route.slice(secret.length + 2) : '';
		if (request.method !== 'GET' || !paths.has(name)) {
			response.writeHead(404).end();
			return;
		}
		const config = readConfig();
		response.setHeader('Content-Type', name === 'browser' ? 'application/json' : 'text/plain');
		response.end(
			name === 'get-actions-key'
				? token
				: name === 'is-browser-config-sync'
				? String(config.openSync === true)
				: JSON.stringify(config.openSync === true ? config.store ?? {} : {})
		);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	server.unref();
	const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/${secret}/`;
	return {
		url: base,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			})
	};
}
