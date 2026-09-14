import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/transport.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
