import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The Claude suite: every test runs on a fake Claude Code executable that
 * the SDK spawns, with no key and no network.
 *
 * The core resolves to its source, not to its built `dist`. The tests reach
 * the core's own test support, which imports the source, and one room must
 * be one module. `tsconfig.check.json` maps the same specifiers for the
 * type-checker.
 */
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		// A string alias matches by prefix, so the subpaths come before the bare name.
		alias: [
			{
				find: '@ambionframework/ambion/conformance',
				replacement: source('../ambion/src/conformance.ts'),
			},
			{ find: '@ambionframework/ambion/testing', replacement: source('../ambion/src/testing.ts') },
			{ find: '@ambionframework/ambion/hosting', replacement: source('../ambion/src/hosting.ts') },
			{ find: '@ambionframework/ambion', replacement: source('../ambion/src/index.ts') },
			{ find: '@ambionframework/pi-journal', replacement: source('../pi-journal/src/index.ts') },
			{ find: '@ambionframework/journal', replacement: source('../journal/src/index.ts') },
			// The mixed-room test is the one place that reads Pi, as a test dependency.
			{ find: '@ambionframework/pi', replacement: source('../pi/src/index.ts') },
		],
	},
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
