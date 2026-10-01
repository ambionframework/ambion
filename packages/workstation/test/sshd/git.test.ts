/**
 * The integration tier of `workstationGitBackend`: the git account
 * `lab-git` and the agents on OpenSSH. Only a real `sshd` honors the
 * options of a line in `authorized_keys.ambion`, so this tier runs
 * `gitConformance`, with the hooks of the `ssh` transport. The expiry case
 * of the suite proves that `sshd` refuses a key after its `expiry-time`.
 * The tier also proves that an agent key opens no shell, that `serve`
 * refuses a request outside its pattern, that no agent reads the git
 * account's home, that `from` refuses a key from another source, and that
 * the reflog names the agent that pushed.
 */

import { openWorkspace, type Workspace } from '@ambionframework/workspace';
import {
	type GitConformanceBackend,
	type GitConformanceOptions,
	type GitConformancePair,
	type GitConformanceProbe,
	gitConformance,
} from '@ambionframework/workspace/conformance';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	type WorkstationGitOptions,
	workstationBackend,
	workstationGitBackend,
} from '../../src/index.ts';
import {
	type Backend,
	configPath,
	keyOf,
	options,
	type Ran,
	readSetup,
	run,
	WIPE,
	withEnv,
} from '../support/sshd.ts';

type GitBackend = ReturnType<typeof workstationGitBackend>;
type Pair = GitConformancePair<GitBackend>;

const ANALYST: WorkspaceAgent = { name: 'analyst' };
const REVIEWER: WorkspaceAgent = { name: 'reviewer' };

/** The git account. `setup.sh` makes it outside the agents' group. */
const GIT_ACCOUNT = 'lab-git';

/**
 * A key life between 3 and 5 seconds. `expiry-time` has a resolution of
 * one second, and the server renders it.
 */
const CREDENTIAL_TTL = 4;

/** Start each case with an empty git account, and agents with empty homes. */
async function wipe(bash: Backend): Promise<void> {
	for (const agent of [ANALYST.name, REVIEWER.name]) {
		await withEnv(bash, agent, (env) => run(env, WIPE));
	}
	await withEnv(bash, GIT_ACCOUNT, (env) =>
		run(env, 'rm -rf -- ~/repos ~/.ssh/authorized_keys.ambion'),
	);
}

/** The options of a git backend over the git account, with no template. */
async function gitOptions(): Promise<WorkstationGitOptions> {
	const setup = await readSetup();
	return {
		server: setup.host,
		port: setup.port,
		hostKey: setup.hostKey,
		account: { username: GIT_ACCOUNT, privateKey: await keyOf(setup, GIT_ACCOUNT) },
	};
}

/** The templates of a conformance case, as `workstationGitBackend` takes them. */
const templatesOf = (templates: GitConformanceOptions['templates']) =>
	Object.fromEntries(
		Object.entries(templates).map(([name, template]) => [
			name,
			{
				source: template.files,
				...(template.description === undefined ? {} : { description: template.description }),
			},
		]),
	);

/** The shared registrations already use the workstation registration shape. */
const sharedOf = (shared: GitConformanceOptions['shared']) => ({ ...shared });

/** Run `command` in the shell of `agent`. The connect writes the agent's git files first. */
function shell(workspace: Workspace, agent: WorkspaceAgent, command: string): Promise<Ran> {
	return workspace.use(agent, (env) => run(env, command));
}

/**
 * A copy of the agent's key, and an ssh configuration that names the copy.
 * A later `connect` can rotate the key in `ambion-git.key`, and the copy
 * keeps the old one.
 */
const COPY_KEY = [
	'cp ~/.ssh/ambion-git.key ~/.ssh/probe.key',
	"sed 's/ambion-git\\.key/probe.key/' ~/.ssh/ambion-git.conf > ~/.ssh/probe.conf",
	'cat ~/.ssh/probe.key',
].join(' && ');

/** A read of `templates/blank` with the copy of the key. */
const PROBE =
	"GIT_SSH_COMMAND='ssh -F ~/.ssh/probe.conf' git ls-remote ssh://ambion-git/templates/blank";

async function probeCredential(pair: Pair, agent: WorkspaceAgent): Promise<GitConformanceProbe> {
	const identity = await pair.backend.access.identityFor(agent);
	const copied = await shell(pair.workspace, agent, COPY_KEY);
	if (copied.code !== 0 || copied.output !== identity.privateKey) {
		throw new Error(`The copy of the key is not the key of the identity: ${copied.output}`);
	}
	return {
		expiresAt: identity.expiresAt,
		accepted: async () => {
			const probe = await shell(pair.workspace, agent, PROBE);
			if (probe.code === 0) return true;
			if (probe.output.includes('Permission denied (publickey)')) return false;
			throw new Error(`The probe failed for another reason: ${probe.output}`);
		},
	};
}

/** Clone `url`, and push its tip to a new branch. */
const pushTo = (url: string) =>
	[
		'd=$(mktemp -d)',
		`git clone -q '${url}' "$d/r" && git -C "$d/r" push -q origin HEAD:refs/heads/write-probe`,
		'status=$?',
		'rm -rf -- "$d"',
		'exit $status',
	].join('\n');

const harness: GitConformanceBackend<GitBackend> = {
	name: 'workstation git on OpenSSH',
	shortestCredentialTtl: CREDENTIAL_TTL,
	issueCredentials: async ({ backend, workspace }, agent) => {
		await backend.access.identityFor(agent);
		await workspace.use(agent, async () => undefined);
	},
	writeCredential: async ({ workspace }, agent, url) =>
		(await shell(workspace, agent, pushTo(url))).code === 0,
	probeCredential,
	async open() {
		const bash = workstationBackend(await options());
		const base = await gitOptions();
		await wipe(bash);
		return {
			bash,
			backend: ({ templates, shared, credentialTtl }) =>
				workstationGitBackend({
					...base,
					templates: templatesOf(templates),
					shared: sharedOf(shared),
					...(credentialTtl === undefined ? {} : { credentialTtl }),
				}),
			dispose: async () => bash.dispose?.(),
		};
	},
};

describe.skipIf(configPath === undefined)('workstation git on OpenSSH', () => {
	describe(harness.name, () => {
		for (const c of gitConformance(harness)) it(c.name, c.run);
	});

	describe('the checks of sshd', () => {
		let bash: Backend;
		let workspace: Workspace;
		let url: string;
		let sharedUrl: string;
		beforeAll(async () => {
			bash = workstationBackend(await options());
			await wipe(bash);
			const git = workstationGitBackend({
				...(await gitOptions()),
				templates: { blank: { source: { 'README.md': 'blank\n' } } },
				shared: { notes: { source: { 'README.md': 'seed\n' } } },
			});
			workspace = openWorkspace({ name: 'lab', backend: { bash, git } });
			const outcome = await workspace.git?.use(ANALYST, (env) =>
				env.fork('templates/blank', 'mine'),
			);
			if (outcome?.ok !== true) throw new Error('The fork of templates/blank failed.');
			url = outcome.repository.url;
			const shared = await workspace.git?.use(ANALYST, (env) => env.get('shared/notes'));
			if (shared === undefined) throw new Error('The shared repository was not registered.');
			sharedUrl = shared.url;
		});
		afterAll(async () => workspace.dispose());

		it.each([
			['no command', 'ssh ambion-git'],
			['a shell command', 'ssh ambion-git id'],
			['git-upload-archive', 'ssh ambion-git "git-upload-archive \'/analyst/mine\'"'],
			['a path with ..', 'ssh ambion-git "git-upload-pack \'/analyst/../analyst/mine\'"'],
			['a command after a ;', 'ssh ambion-git "git-upload-pack \'/analyst/mine\'; id"'],
		])('refuses %s, and opens no shell', async (_name, command) => {
			const ran = await shell(workspace, ANALYST, command);
			expect(ran.code).not.toBe(0);
			expect(ran.output).toContain('ambion: refused');
			expect(ran.output).not.toContain('uid=');
		});

		it('keeps every agent out of the home of the git account', async () => {
			const ran = await shell(workspace, REVIEWER, `ls ~${GIT_ACCOUNT}`);
			expect(ran.code).not.toBe(0);
			expect(ran.output).toContain('Permission denied');
		});

		it('refuses a key from a source other than the loopback address', async () => {
			const { external } = await readSetup();
			const loopback = await shell(workspace, ANALYST, `git ls-remote ${url}`);
			expect(loopback.code).toBe(0);
			const other = await shell(
				workspace,
				ANALYST,
				`GIT_SSH_COMMAND='ssh -o HostName=${external}' git ls-remote ${url}`,
			);
			expect(other.code).not.toBe(0);
			expect(other.output).toContain('Permission denied (publickey)');
		});

		it('names the agent that pushed in the reflog, whatever author the commit names', async () => {
			const pushed = await shell(
				workspace,
				ANALYST,
				[
					`git clone -q ${url} ~/mine`,
					'cd ~/mine',
					'echo x > x.txt',
					'git add x.txt',
					'git -c user.name=someone -c user.email=someone@ambion.invalid commit -q -m x',
					'git push -q origin main',
				].join(' && '),
			);
			expect(pushed).toMatchObject({ code: 0 });
			const reflog = await withEnv(bash, GIT_ACCOUNT, (env) =>
				run(env, "git -C ~/repos/analyst/mine.git log -g --format='%gn %an' main"),
			);
			expect(reflog.output.split('\n')[0]).toBe('analyst someone');
		});

		it('checks original shared main ancestry when replacement refs are present', async () => {
			const scenario = await shell(
				workspace,
				ANALYST,
				[
					'set -e',
					'export GIT_AUTHOR_NAME=analyst GIT_AUTHOR_EMAIL=analyst@ambion.invalid GIT_COMMITTER_NAME=analyst GIT_COMMITTER_EMAIL=analyst@ambion.invalid',
					`git clone -q ${sharedUrl} ~/replace-attack`,
					'cd ~/replace-attack',
					'a=$(git rev-parse main)',
					'git switch -q -c linear',
					'echo linear > linear.txt',
					'git add linear.txt',
					'git commit -q -m linear',
					'b=$(git rev-parse HEAD)',
					'git push -q origin HEAD:refs/heads/main',
					'git switch -q -c divergent "$a"',
					'echo divergent > divergent.txt',
					'git add divergent.txt',
					'git commit -q -m divergent',
					'c=$(git rev-parse HEAD)',
					'git push -q origin HEAD:refs/heads/candidate',
					'tree=$(git rev-parse "$c^{tree}")',
					'd=$(printf "forged ancestry\\n" | GIT_AUTHOR_NAME=analyst GIT_AUTHOR_EMAIL=analyst@ambion.invalid GIT_COMMITTER_NAME=analyst GIT_COMMITTER_EMAIL=analyst@ambion.invalid git commit-tree "$tree" -p "$b")',
					'git replace "$c" "$d"',
					'git push -q origin "refs/replace/$c:refs/replace/$c"',
					'git merge-base --is-ancestor "$b" "$c"',
					'if git --no-replace-objects merge-base --is-ancestor "$b" "$c"; then exit 50; fi',
					'if git push --force origin "$c:refs/heads/main" >push.out 2>&1; then cat push.out; exit 51; fi',
					'cat push.out',
					'printf "LINEAR=%s\\nDIVERGENT=%s\\n" "$b" "$c"',
				].join(' && '),
			);
			expect(scenario.code).toBe(0);
			expect(scenario.output).toContain('non-fast-forward push to protected branch');
			const linear = /^LINEAR=([0-9a-f]{40})$/m.exec(scenario.output)?.[1];
			expect(linear).toBeDefined();
			const main = await withEnv(bash, GIT_ACCOUNT, (env) =>
				run(env, 'git -C ~/repos/shared/notes.git rev-parse refs/heads/main'),
			);
			expect(main.output.trim()).toBe(linear);
			const peer = await shell(
				workspace,
				REVIEWER,
				`git clone -q ${sharedUrl} ~/replace-peer && git -C ~/replace-peer show main:linear.txt && if git -C ~/replace-peer cat-file -e main:divergent.txt 2>/dev/null; then exit 1; fi`,
			);
			expect(peer.code, peer.output).toBe(0);
			expect(peer.output).toContain('linear');
		});
	});
});
