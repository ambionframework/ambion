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
 * `tsconfig.json` maps the same specifier for the type-checker.
 *
 * Twenty seconds per test. The directory backend writes real files, and a
 * loaded runner takes one of those past the five-second default while the
 * in-memory backend passes. The assertions are the same either way, so a
 * timeout there reports the runner and not the backend.
 */
export const core = fileURLToPath(new URL('../ambion/src/index.ts', import.meta.url));
/** The core's source names the record; one module, the way the core's own suite reads it. */
export const record = fileURLToPath(new URL('../record/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: { alias: { '@ambionframework/ambion': core, '@ambionframework/record': record } },
	test: { exclude: [...configDefaults.exclude, 'test/live/**'], testTimeout: 20_000 },
});
