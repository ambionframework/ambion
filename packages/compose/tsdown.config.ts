import { defineConfig } from 'tsdown';

/**
 * Two builds. The child of `processEvaluator` runs under `--permission` with
 * no allow flag, so Node loads its entry file and no other file. The child
 * build bundles the setup script that the library shares with it, and it
 * imports only `node:` built-ins. One build with two entries would put the
 * shared script in a chunk that the child cannot load.
 */
export default defineConfig([
	{
		entry: ['src/runtime.ts'],
		format: ['esm'],
		dts: true,
		clean: true,
		outDir: 'dist',
	},
	{
		entry: ['src/child.ts'],
		format: ['esm'],
		dts: false,
		clean: false,
		outDir: 'dist',
	},
]);
