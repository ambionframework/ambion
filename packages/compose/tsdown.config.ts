import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/runtime.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
