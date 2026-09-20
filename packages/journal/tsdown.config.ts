import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/conformance.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
