import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The Codex suite: every test runs on a fake `codex` executable that the
 * SDK spawns, with no key and no network. The example reaches the core
 * through its built entries, so `pnpm build` runs first.
 */
export default defineConfig({
	test: { exclude: [...configDefaults.exclude], testTimeout: 40_000 },
});
