import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The Codex suite: unit tests on the pure parts and on events that a real
 * `codex` recorded. A real model cannot be scripted, so the executor suite
 * runs in the live tier (`vitest.live.config.ts`).
 *
 * The core resolves to its source, as it does for `@ambionframework/claude`.
 * `tsconfig.check.json` maps the same specifiers for the type-checker.
 */
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** The aliases both tiers share. A string alias matches by prefix, so the subpaths come first. */
export const aliases = [
	{
		find: '@ambionframework/ambion/conformance',
		replacement: source('../ambion/src/conformance.ts'),
	},
	{ find: '@ambionframework/ambion/testing', replacement: source('../ambion/src/testing.ts') },
	{ find: '@ambionframework/ambion/hosting', replacement: source('../ambion/src/hosting.ts') },
	{ find: '@ambionframework/ambion', replacement: source('../ambion/src/index.ts') },
	{ find: '@ambionframework/journal', replacement: source('../journal/src/index.ts') },
	// The mixed-room live test is the one place that reads Pi, as a test dependency.
	{ find: '@ambionframework/pi', replacement: source('../pi/src/index.ts') },
];

export default defineConfig({
	resolve: { alias: aliases },
	test: {
		include: ['test/**/*.test.ts'],
		exclude: [...configDefaults.exclude, 'test/live/**'],
		testTimeout: 20_000,
	},
});
