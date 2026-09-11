import { defineConfig } from 'vitest/config';
import { core, journal } from './vitest.config.ts';

/**
 * The live tier: a room on a real model, with a real key, reaching a real
 * workspace. It holds the backends to the one claim a scripted stream cannot
 * prove — that a model picks up the four built-in tools and uses them against
 * a filesystem it has never seen.
 *
 * The settings match the core's live tier, and `docs/toolchain.md` §4 says
 * why each one is what it is.
 */
export default defineConfig({
	resolve: { alias: { '@ambionframework/ambion': core, '@ambionframework/journal': journal } },
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 1,
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
});
