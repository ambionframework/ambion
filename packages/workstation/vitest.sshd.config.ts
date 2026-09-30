import { defineConfig } from 'vitest/config';

/**
 * The integration tier: the workstation against OpenSSH on this machine.
 * Run `test/sshd/setup.sh` as root first, and set `AMBION_WORKSTATION_SSHD`
 * to the file it writes. Without that variable, every test skips.
 */
export default defineConfig({
	// The cases share provisioned Unix homes, repos, and one OpenSSH server.
	test: { include: ['test/sshd/**/*.test.ts'], testTimeout: 30_000, fileParallelism: false },
});
