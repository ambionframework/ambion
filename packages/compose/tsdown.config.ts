import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/conformance.ts', 'src/runtime.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
