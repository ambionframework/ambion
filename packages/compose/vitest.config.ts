import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Every test runs in process or in a child Node process, with no key and no
 * network. The core resolves to its source, as it does in the other packages,
 * so the conformance suite and the types of the core are one module each.
 * `processRuntime` runs the built child entry, `dist/child.mjs`, so a run of
 * this suite needs a build first: `pnpm build`.
 *
 * The debug build of QuickJS runs WebAssembly frames that are larger than
 * the frames of the release build. On arm64, a call from the code to the
 * host passes the default V8 stack of 984 KB. The test process gets 4 MB, below
 * the 8 MB stack of the main thread.
 */
const source = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{
				find: '@ambionframework/ambion/hosting',
				replacement: source('../ambion/src/hosting.ts'),
			},
			{
				find: '@ambionframework/ambion/conformance',
				replacement: source('../ambion/src/conformance.ts'),
			},
			{ find: /^@ambionframework\/ambion$/, replacement: source('../ambion/src/index.ts') },
			{
				find: '@ambionframework/journal/conformance',
				replacement: source('../journal/src/conformance.ts'),
			},
			{ find: '@ambionframework/journal', replacement: source('../journal/src/index.ts') },
		],
	},
	test: {
		exclude: [...configDefaults.exclude],
		testTimeout: 30_000,
		execArgv: ['--stack-size=4000'],
	},
});
