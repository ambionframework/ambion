/**
 * `serve`, the forced command of every agent key, run directly with
 * `SSH_ORIGINAL_COMMAND` set, as `sshd` runs it. The backend prepares the
 * git account on the scripted tier's server and forks `analyst/report`,
 * and each case runs the `serve` that the backend wrote.
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { git, gitBackend, gitServer, hasGitTools } from './support/git.ts';

/** The home of the git account that `beforeEach` prepared. */
let home = '';

/** Run `serve <agent>` for `request`. The flush packet ends each exchange of `git`. */
function serve(agent: string, request: string | undefined) {
	return spawnSync('bash', [join(home, '.ambion', 'serve'), agent], {
		env: {
			PATH: process.env.PATH,
			HOME: home,
			...(request === undefined ? {} : { SSH_ORIGINAL_COMMAND: request }),
		},
		input: '0000',
		encoding: 'utf8',
	});
}

describe.skipIf(!hasGitTools)('serve', () => {
	beforeEach(async () => {
		const server = await gitServer();
		home = server.home;
		const env = await gitBackend(server.options).connect({ name: 'analyst' });
		const forked = await env.fork('templates/blank', 'report');
		if (!forked.ok) throw new Error(`The fork was refused: ${forked.reason}`);
	});

	it.each<[string, string, string | undefined, number, string]>([
		['a read of its own fork', 'analyst', "git-upload-pack '/analyst/report'", 0, ''],
		['a read without the leading slash', 'analyst', "git-upload-pack 'analyst/report'", 0, ''],
		["a read of a peer's fork", 'reviewer', "git-upload-pack '/analyst/report'", 0, ''],
		['a read of a template', 'reviewer', "git-upload-pack '/templates/blank'", 0, ''],
		['a push to its own fork', 'analyst', "git-receive-pack '/analyst/report'", 0, ''],
		[
			"a push to a peer's fork",
			'reviewer',
			"git-receive-pack '/analyst/report'",
			1,
			'reviewer cannot push to analyst/report',
		],
		[
			'a push to a template',
			'analyst',
			"git-receive-pack '/templates/blank'",
			1,
			'analyst cannot push to templates/blank',
		],
		[
			'a push that would create a repository',
			'analyst',
			"git-receive-pack '/analyst/new'",
			1,
			'analyst/new does not exist',
		],
		[
			'a read of template-sources',
			'analyst',
			"git-upload-pack '/template-sources/blank'",
			1,
			'template-sources/blank does not exist',
		],
		['an archive request', 'analyst', "git-upload-archive '/analyst/report'", 1, 'refused'],
		['a path with ..', 'analyst', "git-upload-pack '/analyst/../templates/blank'", 1, 'refused'],
		['a path into .staging', 'analyst', "git-upload-pack '/.staging/x'", 1, 'refused'],
		['a second command', 'analyst', "git-upload-pack '/analyst/report'; id", 1, 'refused'],
		['a shell', 'analyst', 'bash', 1, 'refused'],
		['no command', 'analyst', undefined, 1, 'refused'],
	])('answers %s', (_name, agent, request, status, message) => {
		const ran = serve(agent, request);
		expect(ran.status).toBe(status);
		if (status === 0) expect(ran.stdout).toContain('refs/heads/main');
		else expect(ran.stderr).toContain(`ambion: ${message}`);
	});

	it('names the pushing agent in the reflog, whatever author the commit names', async () => {
		// The test server removes the home, and the scratch folder in it, when the test ends.
		const scratch = join(home, 'scratch');
		await mkdir(scratch);
		// `git` runs this in place of `ssh`: the last argument is the command that `sshd` would get.
		const ssh = join(scratch, 'ssh');
		await writeFile(
			ssh,
			'#!/bin/sh\nfor last; do :; done\nSSH_ORIGINAL_COMMAND="$last" exec bash "$SERVE" "$AGENT"\n',
		);
		await chmod(ssh, 0o755);
		const env = {
			...process.env,
			GIT_SSH_COMMAND: ssh,
			GIT_SSH_VARIANT: 'simple',
			SERVE: join(home, '.ambion', 'serve'),
			AGENT: 'analyst',
			HOME: home,
		};
		const run = (cwd: string, ...args: string[]) =>
			spawnSync('git', args, { cwd, env, encoding: 'utf8' });
		const clone = join(scratch, 'report');
		expect(run(scratch, 'clone', '--quiet', 'ssh://ambion-git/analyst/report', clone).status).toBe(
			0,
		);
		const author = ['-c', 'user.name=someone', '-c', 'user.email=someone@example.invalid'];
		expect(run(clone, ...author, 'commit', '--allow-empty', '-m', 'Week 39').status).toBe(0);
		expect(run(clone, 'push', '--quiet', 'origin', 'main').status).toBe(0);

		const fork = join(home, 'repos', 'analyst', 'report.git');
		expect(git(fork, 'log', '-1', '--format=%an', 'main')).toBe('someone\n');
		expect(git(fork, 'reflog', 'show', '-1', '--format=%gn <%ge>', 'main')).toBe(
			'analyst <analyst@ambion.invalid>\n',
		);
	});
});
