import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The backend suite: every test runs in process, with no key and no network.
 * A test that starts a room drives it with a scripted stream, the way the
 * core's own suite does.
 *
 * The core resolves to its source, not to its built `dist`. The tests reach
 * the core's own test support, which imports the source, and one room must be
 * one module: two copies would hold two `defaultRuntime`s and two catalogs.
 * `tsconfig.check.json` maps the same specifier for the type-checker.
 *
 * The workspace's own specifiers resolve to this package's source too. The
 * tests run on the just-bash backends, and they reach that package's source
 * by relative path: a dependency on it would close a cycle. That source names
 * the workspace by its package name, and one workspace must be one module.
 *
 * Twenty seconds per test. The directory backend writes real files, and a
 * loaded runner takes one of those past the five-second default while the
 * in-memory backend passes. The assertions are the same either way, so a
 * timeout there reports the runner and not the backend.
 */
const core = fileURLToPath(new URL('../ambion/src/index.ts', import.meta.url));
/** The core's host-facing entry, aliased ahead of the bare package name below: a
 * string alias matches by prefix, and the bare entry's file path is not a directory. */
const hosting = fileURLToPath(new URL('../ambion/src/hosting.ts', import.meta.url));
/** The core's source names the journal; one module, the way the core's own suite reads it. */
const journal = fileURLToPath(new URL('../journal/src/index.ts', import.meta.url));
const piJournal = fileURLToPath(new URL('../pi-journal/src/index.ts', import.meta.url));
/** The Pi executor, which names the core; one module, the way the core's own suite reads it. */
const pi = fileURLToPath(new URL('../pi/src/index.ts', import.meta.url));
/** This package's own entries, for the just-bash source that names them. */
const own = (entry: string) => fileURLToPath(new URL(`./src/${entry}`, import.meta.url));
/** The aliases both tiers share. A string alias matches by prefix, so a subpath comes first. */
export const alias = [
	{ find: '@ambionframework/ambion/hosting', replacement: hosting },
	{ find: '@ambionframework/ambion', replacement: core },
	{ find: '@ambionframework/pi-journal', replacement: piJournal },
	{ find: '@ambionframework/pi', replacement: pi },
	{ find: '@ambionframework/journal', replacement: journal },
	{ find: '@ambionframework/workspace/resource', replacement: own('resource-entry.ts') },
	{ find: '@ambionframework/workspace/conformance', replacement: own('conformance.ts') },
	{ find: '@ambionframework/workspace', replacement: own('index.ts') },
];

export default defineConfig({
	resolve: { alias },
	test: { exclude: [...configDefaults.exclude, 'test/live/**'], testTimeout: 20_000 },
});
