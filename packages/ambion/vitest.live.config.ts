import { defineConfig } from 'vitest/config';
import { record } from './vitest.config.ts';

/**
 * The live tier: the same room, on a real model, with a real key. Each file
 * holds the room to one claim that a scripted stream cannot prove.
 *
 * - Files run one at a time. A room of three seats already answers in
 *   parallel; several rooms at once trip provider rate limits, and one file
 *   changes the key in the environment for one test.
 * - One retry. A model can give one bad sample; a test that needs the retry
 *   shows in the report as retried, and a test that fails twice fails the run.
 * - Three minutes per test. A live room that never goes quiet is the gap
 *   `docs/agent.md` §7 names, and the deadline inside `support.ts` reports it
 *   before this one does.
 */
export default defineConfig({
	resolve: { alias: { '@ambionframework/record': record } },
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 1,
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
});
