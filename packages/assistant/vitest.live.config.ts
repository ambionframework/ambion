import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		// One exchange of 90 s and a grade. A case of more exchanges sets its own.
		testTimeout: 300_000,
	},
});
