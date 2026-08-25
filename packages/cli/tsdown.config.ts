import { defineConfig } from 'tsdown';

export default defineConfig({
	// Written to dist/ambion.mjs, which bin/ambion.mjs hands off to.
	entry: { ambion: 'src/main.ts' },
	format: ['esm'],
	// The CLI ships one binary and no importable subpaths, so declarations
	// would be dead weight.
	dts: false,
	clean: true,
	outDir: 'dist',
	// The user's workspace file imports the runtime from its own node_modules.
	// Bundling a second copy in here would give the process two runtimes.
	deps: { neverBundle: ['@ambionframework/ambion'] },
});
