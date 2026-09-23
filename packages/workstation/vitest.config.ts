import { configDefaults, defineConfig } from 'vitest/config';

/**
 * The scripted tier: an SSH server in the test process serves a temporary
 * directory on the local disk, so every test runs with no container and no
 * network. The integration tier against a real `sshd` lives in `test/sshd`
 * and runs in its own CI job.
 */
export default defineConfig({
	test: { exclude: [...configDefaults.exclude, 'test/sshd/**'], testTimeout: 20_000 },
});
