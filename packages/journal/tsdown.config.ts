import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/pi.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
