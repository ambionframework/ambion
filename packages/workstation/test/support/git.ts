/**
 * The git account on the scripted tier's SSH server: one account,
 * `lab-git`, whose home is a temporary folder on the local disk, and the
 * options of a `workstationGitBackend` that reach it.
 *
 * The scripts of the backend run as the user that runs the test, so the
 * tier needs `git`, `flock`, and `setsid --wait` on this machine.
 */

import { spawnSync } from 'node:child_process';
import { afterEach } from 'vitest';
import { type WorkstationGitOptions, workstationGitBackend } from '../../src/index.ts';
import { startSshServer, type TestServer } from './server.ts';
import { hasSetsid } from './setsid.ts';

/** Whether this machine runs the scripts of the git account. */
export const hasGitTools =
	hasSetsid &&
	spawnSync('git', ['--version']).status === 0 &&
	spawnSync('flock', ['--version']).status === 0;

/** The templates of most cases. */
export const TEMPLATES: NonNullable<WorkstationGitOptions['templates']> = {
	'weekly-report': {
		description: 'A weekly status report.',
		source: { 'report.md': '# Week\n', 'data/numbers.csv': 'a,b\n1,2\n' },
	},
	blank: { source: { 'README.md': 'blank\n' } },
};

/** A test server with the git account, and the options of a backend over it. */
export interface GitServer {
	readonly server: TestServer;
	/** The home of the git account on the local disk. */
	readonly home: string;
	readonly options: WorkstationGitOptions;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Start a server with the account `lab-git`. The test's end stops it. */
export async function gitServer(): Promise<GitServer> {
	const server = await startSshServer(['lab-git']);
	cleanups.push(() => server.stop());
	const credential = await server.options.credentialFor({ name: 'lab-git' });
	const home = server.homes.get('lab-git');
	if (home === undefined) throw new Error('The test server has no home for lab-git.');
	const { host, port, hostKey } = server.options;
	return {
		server,
		home,
		options: { host, port, hostKey, account: credential, templates: TEMPLATES },
	};
}

/** A backend over `options`. The test's end disposes it. */
export function gitBackend(options: WorkstationGitOptions) {
	const backend = workstationGitBackend(options);
	cleanups.push(async () => backend.dispose?.());
	return backend;
}

/** Run `git` in `cwd`, and give its stdout. A failure throws with its stderr. */
export function git(cwd: string, ...args: string[]): string {
	const ran = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (ran.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${ran.stderr}`);
	return ran.stdout;
}
