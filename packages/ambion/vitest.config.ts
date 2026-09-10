import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The scripted suite: every test runs on a scripted stream, in process, with
 * no key and no network. `test/live` is the other tier, and it costs money,
 * so `vitest.live.config.ts` runs it on purpose and nothing runs it by chance.
 */
export default defineConfig({
	test: {
		// The scenarios run on three storages, two of them on disk: a test under the gate's load takes seconds.
		testTimeout: 20_000,
		exclude: [...configDefaults.exclude, 'test/live/**'],
	},
});
