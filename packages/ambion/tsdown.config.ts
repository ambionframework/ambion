import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/hosting.ts', 'src/conformance.ts', 'src/testing.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
