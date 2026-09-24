import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The Pi suite: every test runs on a scripted stream, in process, with no key
 * and no network.
 *
 * The core and the journals resolve to their source, not to their built
 * `dist`. The tests reach the core's own test support, which imports the
 * source, and one room must be one module: two copies would hold two
 * `defaultRuntime`s. `tsconfig.check.json` maps the same specifiers for the
 * type-checker.
 */
export const core = fileURLToPath(new URL('../ambion/src/index.ts', import.meta.url));
/** Aliased ahead of the bare package name: a string alias matches by prefix. */
export const hosting = fileURLToPath(new URL('../ambion/src/hosting.ts', import.meta.url));
export const conformance = fileURLToPath(new URL('../ambion/src/conformance.ts', import.meta.url));
export const testing = fileURLToPath(new URL('../ambion/src/testing.ts', import.meta.url));
export const journal = fileURLToPath(new URL('../journal/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@ambionframework/ambion/conformance', replacement: conformance },
			{ find: '@ambionframework/ambion/testing', replacement: testing },
			{ find: '@ambionframework/ambion/hosting', replacement: hosting },
			{ find: '@ambionframework/ambion', replacement: core },
			{ find: '@ambionframework/journal', replacement: journal },
		],
	},
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
