import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The emulator suite: every test runs in process, with no key and no network.
 * A test that starts a room drives it with a scripted stream, the way the
 * core's own suite does.
 *
 * Every dependency resolves to its source, not to its built `dist`: `Room`
 * must be one module across this package and the core's own tests, or two
 * copies would hold two `defaultRuntime`s and two catalogs. `tsconfig.json`
 * maps the same specifiers for the type-checker.
 *
 * Twenty seconds per test. The directory backend writes real files, and a
 * loaded runner takes one of those past the five-second default while the
 * in-memory backend passes. The assertions are the same either way, so a
 * timeout there reports the runner and not the backend.
 */
export const workspace = fileURLToPath(new URL('../workspace/src/index.ts', import.meta.url));
export const core = fileURLToPath(new URL('../ambion/src/index.ts', import.meta.url));
/** The core's host-facing entry, aliased ahead of the bare package name below: a
 * string alias matches by prefix, and the bare entry's file path is not a directory. */
export const hosting = fileURLToPath(new URL('../ambion/src/hosting.ts', import.meta.url));
/** The core's source names the journal; one module, the way the core's own suite reads it. */
export const journal = fileURLToPath(new URL('../journal/src/index.ts', import.meta.url));
export const piJournal = fileURLToPath(new URL('../pi-journal/src/index.ts', import.meta.url));
/** The Pi executor, which names the core; one module, the way the core's own suite reads it. */
export const pi = fileURLToPath(new URL('../pi/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@ambionframework/ambion/hosting', replacement: hosting },
			{ find: '@ambionframework/ambion', replacement: core },
			{ find: '@ambionframework/pi-journal', replacement: piJournal },
			{ find: '@ambionframework/pi', replacement: pi },
			{ find: '@ambionframework/journal', replacement: journal },
			{ find: '@ambionframework/workspace', replacement: workspace },
		],
	},
	test: { exclude: [...configDefaults.exclude, 'test/live/**'], testTimeout: 20_000 },
});
