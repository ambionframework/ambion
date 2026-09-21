import { defineConfig } from 'tsdown';

// The room tools server is an entry of its own. Codex spawns it with `node`,
// so the package ships it as `dist/room-tools-server.mjs`.
export default defineConfig({
	entry: ['src/index.ts', 'src/room-tools-server.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	outDir: 'dist',
});
