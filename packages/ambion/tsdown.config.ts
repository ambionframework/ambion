import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/host.ts', 'src/protocol.ts', 'src/node.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
