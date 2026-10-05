import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The suite of the stores: every test runs in process, over both stores.
 * Nothing here starts a room, and nothing needs a key.
 *
 * Twenty seconds per test. The SQLite reopen test writes a real file, and a
 * loaded runner can take it past the five-second default.
 */
export default defineConfig({
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
