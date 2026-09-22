import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The contract suite: every test runs in process, with no key and no
 * network, no backend and no model library.
 *
 * The core resolves to its source, not to its built `dist`, the same as
 * every other package's suite: one room must be one module, or two copies
 * would hold two `defaultRuntime`s and two catalogs. `tsconfig.json` maps the
 * same specifier for the type-checker.
 */
export const core = fileURLToPath(new URL('../ambion/src/index.ts', import.meta.url));
/** The core's host-facing entry, aliased ahead of the bare package name below: a
 * string alias matches by prefix, and the bare entry's file path is not a directory. */
export const hosting = fileURLToPath(new URL('../ambion/src/hosting.ts', import.meta.url));
/** The core's source names the journal; one module, the way the core's own suite reads it. */
export const journal = fileURLToPath(new URL('../journal/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@ambionframework/ambion/hosting', replacement: hosting },
			{ find: '@ambionframework/ambion', replacement: core },
			{ find: '@ambionframework/journal', replacement: journal },
		],
	},
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
