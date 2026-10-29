import http from 'http';
import { loadConfig, ServerConfig } from './config';
import { Store } from './store';
import { Events } from './events';
import { Runtime } from './runtime';
import { createApp } from './http';

export async function startServer(config: ServerConfig = loadConfig()) {
	const store = new Store(config.dataDir, config.keyFile);
	const events = new Events(config.dataDir);
	const runtime = new Runtime({ ...config, lockDescriptor: store.lockDescriptor }, (type, data) =>
		events.publish(type, data)
	);
	const server = http.createServer(createApp(config, store, runtime, events));
	server.requestTimeout = 60000;
	server.headersTimeout = 15000;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(config.port, config.host, () => {
				server.off('error', reject);
				resolve();
			});
		});
	} catch (error) {
		store.close();
		throw error;
	}
	events.publish('server.started', {});
	let closing: Promise<void> | undefined;
	return {
		server,
		store,
		runtime,
		events,
		close: () => {
			if (!closing)
				closing = (async () => {
					const closed = new Promise<void>((resolve) => server.close(() => resolve()));
					events.publish('server.stopping', {});
					server.closeAllConnections();
					try {
						await runtime.close();
						await closed;
					} finally {
						store.close();
					}
				})();
			return closing;
		}
	};
}

if (require.main === module) {
	startServer()
		.then((service) => {
			console.log(`OCS headless API listening on ${JSON.stringify(service.server.address())}`);
			console.log('Read the admin token from OCS_DATA_DIR/admin.token or use OCS_AUTH_TOKEN.');
			let stopping = false;
			const stop = () => {
				if (stopping) return;
				stopping = true;
				const timer = setTimeout(() => process.exit(1), 20000);
				timer.unref();
				service
					.close()
					.then(() => {
						clearTimeout(timer);
						process.exitCode = 0;
					})
					.catch(() => process.exit(1));
			};
			process.on('SIGINT', stop);
			process.on('SIGTERM', stop);
		})
		.catch((error) => {
			console.error(`Server startup failed: ${error.message}`);
			process.exitCode = 1;
		});
}
