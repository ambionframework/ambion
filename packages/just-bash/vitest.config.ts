import { defineConfig } from 'vitest/config';

/**
 * Every test runs in process, with no key and no network. The workspace
 * resolves to its built `dist`, the way a consumer of this package reads it.
 *
 * Twenty seconds per test. The directory backend writes real files, and a
 * loaded runner takes one of those past the five-second default while the
 * in-memory backend passes.
 */
export default defineConfig({
	test: { testTimeout: 20_000 },
});
