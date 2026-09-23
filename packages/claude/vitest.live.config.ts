import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The Claude live tier: rooms on the real Claude Agent SDK, with a real key.
 * Each file holds one claim that a fake executable cannot prove. The
 * settings match the core's live tier, and `docs/toolchain.md` §8 says why.
 *
 * - Files run one at a time, so rooms do not trip provider rate limits.
 * - One retry. A test that needs it shows in the report as retried.
 * - Three minutes per test.
 */
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: '@ambionframework/ambion/hosting', replacement: source('../ambion/src/hosting.ts') },
			{ find: '@ambionframework/ambion', replacement: source('../ambion/src/index.ts') },
			{ find: '@ambionframework/journal', replacement: source('../journal/src/index.ts') },
			{ find: '@ambionframework/pi', replacement: source('../pi/src/index.ts') },
		],
	},
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 1,
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
});
