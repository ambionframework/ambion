import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/live/**/*.test.ts'],
		fileParallelism: false,
		retry: 0,
		testTimeout: 120_000,
	},
});
