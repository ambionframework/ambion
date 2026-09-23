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
 * The journal resolves to its source, not to its built `dist`. The suite runs
 * against the code in this repository. Native child processes use package
 * exports; `test:live` builds workspace dependencies before those tests run.
 */
export const journal = fileURLToPath(new URL('../journal/src/index.ts', import.meta.url));
export const journalConformance = fileURLToPath(
	new URL('../journal/src/conformance.ts', import.meta.url),
);
/**
 * The core's tests build rooms with the Pi executor, so they read its source
 * by relative path. The Pi source names the core by its package name, and
 * these two aliases send that name to the core's own source: one room must
 * be one module. The hosting entry comes first because a string alias
 * matches by prefix.
 */
export const core = fileURLToPath(new URL('./src/index.ts', import.meta.url));
export const hosting = fileURLToPath(new URL('./src/hosting.ts', import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@ambionframework/ambion/hosting', replacement: hosting },
			{ find: '@ambionframework/ambion', replacement: core },
			{ find: '@ambionframework/journal/conformance', replacement: journalConformance },
			{ find: '@ambionframework/journal', replacement: journal },
		],
	},
	test: {
		exclude: [...configDefaults.exclude, 'test/live/**'],
		testTimeout: 20_000,
	},
});
