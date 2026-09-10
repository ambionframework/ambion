import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * The workerd tier: every test runs inside Cloudflare's runtime, against the
 * two objects `wrangler.jsonc` declares, with SQLite storage and alarms the
 * test drives by hand. The runtime's module graph is large, and workerd
 * transforms it on the first import, so a test gets a minute.
 */
export default defineConfig({
	test: { testTimeout: 60_000, hookTimeout: 60_000 },
	plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
