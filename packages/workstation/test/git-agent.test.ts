/**
 * The agent side of `workstationGitBackend` on the scripted tier: the
 * files that `workstationBackend` writes into the agent's `~/.ssh` at each
 * `connect`. The test server does not run the agent's `ssh`. The OpenSSH
 * tier proves that `git` reaches the git account with these files.
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openWorkspace } from '@ambionframework/workspace';
import { describe, expect, it, onTestFinished } from 'vitest';
import { workstationBackend } from '../src/index.ts';
import { gitBackend, gitServer, hasGitTools } from './support/git.ts';

const ANALYST = { name: 'analyst' };

/** The mode bits of `path`. */
const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

/** A workspace over both backends of one test server, and the analyst's `~/.ssh`. The test's end disposes it. */
async function pair() {
	const { server, options } = await gitServer(['analyst']);
	const bash = workstationBackend(server.options);
	const git = gitBackend(options);
	const workspace = openWorkspace({ name: 'lab', backend: { bash, git } });
	onTestFinished(() => workspace.dispose());
	const connect = () => workspace.use(ANALYST, async () => undefined);
	const home = server.homes.get('analyst') ?? '';
	return { bash, git, workspace, connect, ssh: join(home, '.ssh'), port: options.port };
}

describe.skipIf(!hasGitTools)('the git files of an agent', () => {
	it('writes the key, the known host, and the configuration, and puts the Include line first', async () => {
		const { git, connect, ssh, port } = await pair();
		await connect();
		const identity = await git.access.identityFor(ANALYST);

		expect(await modeOf(ssh)).toBe(0o700);
		for (const name of ['ambion-git.key', 'ambion-git.known_hosts', 'ambion-git.conf', 'config']) {
			expect(await modeOf(join(ssh, name))).toBe(0o600);
		}
		expect(await readFile(join(ssh, 'ambion-git.key'), 'utf8')).toBe(identity.privateKey);
		expect(await readFile(join(ssh, 'ambion-git.known_hosts'), 'utf8')).toBe(
			`ambion-git ${identity.hostKey}\n`,
		);
		expect(await readFile(join(ssh, 'ambion-git.conf'), 'utf8')).toBe(
			[
				'Host ambion-git',
				'  HostName 127.0.0.1',
				`  Port ${port}`,
				'  User lab-git',
				'  IdentityFile ~/.ssh/ambion-git.key',
				'  IdentitiesOnly yes',
				'  HostKeyAlias ambion-git',
				'  UserKnownHostsFile ~/.ssh/ambion-git.known_hosts',
				'  StrictHostKeyChecking yes',
				'  BatchMode yes',
				'',
			].join('\n'),
		);
		expect(await readFile(join(ssh, 'config'), 'utf8')).toBe('Include ambion-git.conf\n');
	});

	it('keeps the rest of ~/.ssh/config, and writes again a file that is gone or open to others', async () => {
		const { connect, ssh } = await pair();
		await mkdir(ssh, { mode: 0o700 });
		const own = 'Host build\n  User ci\n';
		await writeFile(join(ssh, 'config'), own, { mode: 0o644 });
		await connect();
		const config = `Include ambion-git.conf\n${own}`;
		expect(await readFile(join(ssh, 'config'), 'utf8')).toBe(config);
		const key = await readFile(join(ssh, 'ambion-git.key'), 'utf8');

		await rm(join(ssh, 'ambion-git.conf'));
		await chmod(join(ssh, 'ambion-git.key'), 0o644);
		await connect();
		expect(await readFile(join(ssh, 'config'), 'utf8')).toBe(config);
		expect(await readFile(join(ssh, 'ambion-git.conf'), 'utf8')).toContain('Host ambion-git');
		expect(await readFile(join(ssh, 'ambion-git.key'), 'utf8')).toBe(key);
		expect(await modeOf(join(ssh, 'ambion-git.key'))).toBe(0o600);
	});

	it('refuses a git access of another transport, and fails a connect with no key', async () => {
		const { bash, git } = await pair();
		expect(bash.gitTransports).toEqual(['ssh']);
		await expect(
			bash.connect(ANALYST, undefined, { git: { transport: 'in-process' } }),
		).rejects.toThrow(/carries the git transport ssh, and the git access uses in-process/);
		await git.dispose?.();
		await expect(bash.connect(ANALYST, undefined, { git: git.access })).rejects.toThrow(/disposed/);
		const env = await bash.connect(ANALYST);
		await env.cleanup();
	});
});
