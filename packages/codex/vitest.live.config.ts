import { defineConfig } from 'vitest/config';
import { aliases } from './vitest.config.ts';

/**
 * The live tier: a room with a Codex seat, on a real `codex` and a real
 * model, with a real key. Each file holds the room to one claim that a
 * recorded stream cannot prove. It costs money, so it never runs on a
 * pull request. Without `CODEX_API_KEY` every file skips.
 *
 * - Files run one at a time, because rooms at once trip provider rate limits.
 * - One retry. A model can give one bad sample.
 * - Three minutes per test.
 */
export default defineConfig({
	resolve: { alias: aliases },
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 1,
		testTimeout: 180_000,
		hookTimeout: 60_000,
	},
});
