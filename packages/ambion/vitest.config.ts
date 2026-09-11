import { fileURLToPath } from 'node:url';
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

/**
 * The record resolves to its source, not to its built `dist`. The suite runs
 * against the code in this repository, so a tier never reads a stale build,
 * and the live tier needs no build at all.
 */
export const record = fileURLToPath(new URL('../record/src/index.ts', import.meta.url));

export default defineConfig({
	resolve: { alias: { '@ambionframework/record': record } },
	test: {
		exclude: [...configDefaults.exclude, 'test/live/**'],
		testTimeout: 20_000,
	},
});
