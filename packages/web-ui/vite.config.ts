import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The console is same-origin by default. The dev proxy keeps Host/Origin unless
// changeOrigin is enabled; a separate API origin needs OCS_ALLOWED_ORIGINS.
// Production builds are served by the backend from packages/server/web.
const backend = process.env.OCS_DEV_BACKEND || 'http://127.0.0.1:15319';

export default defineConfig({
	plugins: [vue()],
	base: './',
	resolve: {
		alias: {
			'@': '/src'
		}
	},
	server: {
		// Bind IPv4 explicitly: Node may resolve `localhost` to ::1 on Windows,
		// while browsers commonly connect to 127.0.0.1 first.
		host: '127.0.0.1',
		port: 3000,
		strictPort: true,
		proxy: {
			'/api': { target: backend, changeOrigin: false },
			'/healthz': { target: backend, changeOrigin: false }
		}
	},
	build: {
		outDir: '../server/web',
		emptyOutDir: true,
		target: 'es2022',
		sourcemap: false
	}
});
