import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
	// The runtime's own module: workerd provides it, and no bundle carries it.
	external: ['cloudflare:workers'],
});
