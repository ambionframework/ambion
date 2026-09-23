import { defineConfig } from 'vitest/config';

/**
 * The integration tier: the workstation against OpenSSH on this machine.
 * Run `test/sshd/setup.sh` as root first, and set `AMBION_WORKSTATION_SSHD`
 * to the file it writes. Without that variable, every test skips.
 */
export default defineConfig({
	test: { include: ['test/sshd/**/*.test.ts'], testTimeout: 30_000 },
});
