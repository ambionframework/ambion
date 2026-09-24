/**
 * The package's one entry, and what it names: the bash backend, the git
 * backend, the default idle timeout, and the fingerprint helper.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import * as main from '../src/index.ts';

const manifest = async () =>
	JSON.parse(
		await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
	) as {
		name: string;
		exports: Record<string, unknown>;
	};

it('keeps the exported package name in step with the manifest', async () => {
	expect(main.PACKAGE_NAME).toBe((await manifest()).name);
});

it('holds one entry', async () => {
	expect(Object.keys((await manifest()).exports).sort()).toEqual(['.', './package.json']);
});

it('exports the two backends, the default idle timeout, and the fingerprint helper', () => {
	expect(Object.keys(main).sort()).toEqual([
		'DEFAULT_IDLE_TIMEOUT_SECONDS',
		'PACKAGE_NAME',
		'fingerprint',
		'workstationBackend',
		'workstationGitBackend',
	]);
});

it('names the types of the git backend', () => {
	const access: main.WorkstationGitAccess = {
		transport: 'ssh',
		identityFor: async (): Promise<main.WorkstationGitIdentity> => {
			throw new Error('unused');
		},
	};
	const options: main.WorkstationGitOptions = {
		host: 'lab.internal',
		hostKey: 'SHA256:unused',
		account: { username: 'lab-git', privateKey: 'unused' },
	};
	expect([access.transport, options.account.username]).toEqual(['ssh', 'lab-git']);
});
