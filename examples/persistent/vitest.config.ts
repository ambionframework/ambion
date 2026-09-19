import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The scripted suite. `test/live` is the other tier, and it costs money, so
 * `vitest.live.config.ts` runs it on purpose and nothing runs it by chance.
 *
 * Twenty seconds per test. Each test launches the host as a child process and
 * drives it over HTTP, and a loaded runner takes one past the five-second
 * default while the same test passes at a desk. The assertions are the same
 * either way, so a timeout there reports the runner and not the host.
 */
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, 'test/live/**'],
		testTimeout: 20_000,
	},
});
