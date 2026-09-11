import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The scripted suite: every test runs on a scripted stream, in process, with
 * no key and no network. `test/live` is the other tier, and it costs money,
 * so `vitest.live.config.ts` runs it on purpose and nothing runs it by chance.
 *
 * Twenty seconds per test. Each `describe.each(storages)` suite runs one body
 * three times, on `memory`, on `jsonl` and on `sqlite`. The last two write
 * real files, and a loaded runner takes one of them past the five-second
 * default while the first passes. The assertions are the same either way, so
 * a timeout there reports the runner and not the room.
 */
export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, 'test/live/**'],
		testTimeout: 20_000,
	},
});
