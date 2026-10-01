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

it('names the types of the git backend, and takes no other git backend in the bash options', () => {
	const unused = async (): Promise<never> => {
		throw new Error('unused');
	};
	const access: main.WorkstationGitAccess = {
		identityFor: async (): Promise<main.WorkstationGitIdentity> => unused(),
	};
	const git: main.WorkstationGitBackend = { access, label: 'ssh://unused', connect: unused };
	// @ts-expect-error A git backend with no workstation access does not pair.
	const other: main.WorkstationOptions['git'] = { label: 'ssh://unused', connect: unused };
	const options: main.WorkstationGitOptions = {
		server: 'lab.internal',
		hostKey: 'SHA256:unused',
		account: { username: 'lab-git', privateKey: 'unused' },
	};
	expect([git.label, other?.label, options.account.username]).toEqual([
		'ssh://unused',
		'ssh://unused',
		'lab-git',
	]);
});
