import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The scripted suite: every test runs on a scripted stream, in process, with
 * no key and no network. `test/live` is the other tier, and it costs money,
 * so `vitest.live.config.ts` runs it on purpose and nothing runs it by chance.
 */
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, 'test/live/**'],
	},
});
