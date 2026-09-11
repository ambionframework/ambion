import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The record's own suite: every test runs in process, against a storage the
 * test opens. Nothing here starts a room, and nothing needs a key.
 *
 * Twenty seconds per test. A test over the JSONL or the SQLite storage
 * writes real files, and a loaded runner takes one of those past the
 * five-second default while the in-memory storage passes.
 */
export default defineConfig({
	test: { exclude: [...configDefaults.exclude], testTimeout: 20_000 },
});
