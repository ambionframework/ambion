import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		// Three moves, the exchanges, and a grade, each with its own bound.
		testTimeout: 600_000,
	},
});
