import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		// Up to three exchanges of 90 s each, an actor, and a grade.
		testTimeout: 600_000,
	},
});
