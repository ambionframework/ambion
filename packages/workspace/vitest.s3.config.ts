import { defineConfig } from 'vitest/config';
import { alias } from './vitest.config.ts';

/**
 * The S3 tier: the object backend against MinIO in Docker on this machine.
 * Run `test/s3/setup.sh` first, and set `AMBION_S3` to the file it writes.
 * Without that variable, every test skips.
 */
export default defineConfig({
	resolve: { alias },
	test: { include: ['test/s3/**/*.test.ts'], testTimeout: 30_000 },
});
