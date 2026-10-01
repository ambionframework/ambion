/**
 * What `justGitBackend` holds beyond the conformance cases: the tokens, the
 * registration after a crash, a restart over one file, the hidden
 * `template-sources`, a shell variable that tries to carry a token, a token
 * on a path of another repository, and the templates from a directory.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	BACKGROUND_CONTEXT,
	fromDirectory,
	openWorkspace,
	runScript,
	type Workspace,
} from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { justGitBackend, sqliteGitStorage } from '../src/git/index.ts';
import { openServer } from '../src/git/server.ts';
import { signToken, tokenOf, verifyToken } from '../src/git/tokens.ts';
import { memoryBackend } from '../src/index.ts';
import { SECRET } from './support/git-fixture.ts';

const ANALYST = { name: 'analyst' };
const REVIEWER = { name: 'reviewer' };
const TEMPLATES = { blank: { source: { 'README.md': 'blank\n' } } };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'ambion-git-test-'));
	cleanup.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

function workspaceOver(file: string, options: Partial<Parameters<typeof justGitBackend>[0]> = {}) {
	const git = justGitBackend({
		storage: sqliteGitStorage(file),
		secret: SECRET,
		templates: TEMPLATES,
		...options,
	});
	const workspace = openWorkspace({
		name: 'git-test',
		backend: { bash: memoryBackend({ git }) },
	});
	cleanup.push(() => workspace.dispose());
	return { git, workspace };
}

async function sh(workspace: Workspace, agent: { name: string }, command: string) {
	const ran = await workspace.use(agent, (env) =>
		runScript(
			env,
			command,
			{ capture: { limits: { maxBytes: 100_000, maxLines: 1000 } } },
			BACKGROUND_CONTEXT,
		),
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output: ran.value.output };
}

describe('tokens', () => {
	const claims = {
		agent: 'analyst',
		repository: 'analyst/x',
		scope: 'write' as const,
		expiresAt: 2_000,
	};

	it('verify a signed token until it expires, and refuse a changed one', () => {
		const token = signToken(SECRET, claims);
		expect(verifyToken(SECRET, token, 1_000)).toEqual(claims);
		expect(verifyToken(SECRET, token, 2_000)).toBeUndefined();
		expect(verifyToken('another-secret', token, 1_000)).toBeUndefined();
		const [body] = token.split('.');
		const forged = Buffer.from(JSON.stringify({ ...claims, repository: 'reviewer/x' })).toString(
			'base64url',
		);
		expect(verifyToken(SECRET, token.replace(body ?? '', forged), 1_000)).toBeUndefined();
	});

	it.each([
		['Bearer abc', 'abc'],
		[`Basic ${Buffer.from('ambion:abc').toString('base64')}`, 'abc'],
		[`Basic ${Buffer.from('no-colon').toString('base64')}`, undefined],
		['Digest abc', undefined],
		[null, undefined],
	])('read the token of %s', (header, token) => {
		expect(tokenOf(header)).toBe(token);
	});
});

describe('justGitBackend', () => {
	it('keeps a pushed branch across a restart over one file', async () => {
		const file = join(await tempDir(), 'git.db');
		const first = workspaceOver(file);
		const forked = await first.workspace.git?.use(ANALYST, (env) =>
			env.fork('templates/blank', 'work'),
		);
		if (!forked?.ok) throw new Error('the fork was refused');
		const url = forked.repository.url;
		const pushed = await sh(
			first.workspace,
			ANALYST,
			`git clone ${url} ~/work && cd ~/work && git switch -c kept && echo kept > kept.txt && git add kept.txt && git commit -m kept && git push origin kept`,
		);
		expect(pushed.code, pushed.output).toBe(0);
		await first.workspace.dispose();
		const second = workspaceOver(file);
		const read = await sh(
			second.workspace,
			ANALYST,
			`git clone ${url} ~/again && cd ~/again && git checkout kept && cat kept.txt`,
		);
		expect(read.code, read.output).toBe(0);
		expect(read.output).toContain('kept');
	});

	it('finishes a registration that stopped after the commit to template-sources', async () => {
		const file = join(await tempDir(), 'git.db');
		const store = sqliteGitStorage(file).open();
		const server = openServer({ storage: store.storage, secret: SECRET });
		await server.createRepo('template-sources/blank', { defaultBranch: 'main' });
		await server.commit('template-sources/blank', {
			files: { 'README.md': 'blank\n' },
			message: 'Register the template blank\n',
			author: { name: 'ambion', email: 'ambion@ambion.invalid' },
			branch: 'main',
		});
		store.registry.begin('templates/stale', undefined, undefined);
		await server.close();
		store.close();
		const { workspace } = workspaceOver(file);
		const listed = await workspace.git?.use(ANALYST, (env) => env.list());
		expect(listed?.map((repository) => repository.id)).toEqual(['templates/blank']);
	});

	it('publishes a shared seed after restart without rereading an interrupted source', async () => {
		const file = join(await tempDir(), 'git.db');
		const store = sqliteGitStorage(file).open();
		const server = openServer({ storage: store.storage, secret: SECRET });
		store.registry.begin('shared/interrupted', undefined, 'Before restart.');
		await server.createRepo('shared/interrupted', { defaultBranch: 'main' });
		const { hash } = await server.commit('shared/interrupted', {
			files: { 'README.md': 'committed seed\n' },
			message: 'Register the shared repository interrupted\n',
			author: { name: 'ambion', email: 'ambion@ambion.invalid' },
			branch: 'main',
		});
		await server.close();
		store.close();
		const { workspace } = workspaceOver(file, {
			shared: {
				interrupted: {
					source: {
						read: async () => {
							throw new Error('the committed seed source was read after restart');
						},
					},
					description: 'Recovered description.',
				},
			},
		});
		const recovered = await workspace.git?.use(ANALYST, (env) => env.get('shared/interrupted'));
		expect(recovered?.branches.main).toBe(hash);
		expect(recovered?.description).toBe('Recovered description.');
	});

	it('keeps an interrupted committed shared seed visible when it is omitted after restart', async () => {
		const file = join(await tempDir(), 'git.db');
		const store = sqliteGitStorage(file).open();
		const server = openServer({ storage: store.storage, secret: SECRET });
		store.registry.begin('shared/committed', undefined, 'Committed description.');
		await server.createRepo('shared/committed', { defaultBranch: 'main' });
		const { hash } = await server.commit('shared/committed', {
			files: { 'README.md': 'durable seed\n' },
			message: 'Register the shared repository committed\n',
			author: { name: 'ambion', email: 'ambion@ambion.invalid' },
			branch: 'main',
		});
		await server.close();
		store.close();
		const { workspace } = workspaceOver(file);
		const visible = await workspace.git?.use(ANALYST, (env) => env.get('shared/committed'));
		expect(visible?.branches.main).toBe(hash);
		expect(visible?.description).toBe('Committed description.');
	});

	it('hides an interrupted unborn shared repository when omitted, then finishes its registered seed', async () => {
		const file = join(await tempDir(), 'git.db');
		const store = sqliteGitStorage(file).open();
		const server = openServer({ storage: store.storage, secret: SECRET });
		store.registry.begin('shared/unborn', undefined, 'Unborn description.');
		await server.createRepo('shared/unborn', { defaultBranch: 'main' });
		await server.close();
		store.close();
		const omitted = workspaceOver(file);
		const hidden = await omitted.workspace.git?.use(ANALYST, (env) => env.get('shared/unborn'));
		expect(hidden).toBeUndefined();
		await omitted.workspace.dispose();
		const registered = workspaceOver(file, {
			shared: {
				unborn: {
					source: { 'README.md': 'completed seed\n' },
					description: 'Completed description.',
				},
			},
		});
		const completed = await registered.workspace.git?.use(ANALYST, (env) =>
			env.get('shared/unborn'),
		);
		expect(completed?.branches.main).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
		expect(completed?.description).toBe('Completed description.');
		const contents = await sh(
			registered.workspace,
			ANALYST,
			`git clone ${completed?.url ?? ''} ~/unborn && cat ~/unborn/README.md`,
		);
		expect(contents.code, contents.output).toBe(0);
		expect(contents.output).toContain('completed seed');
	});

	it('finishes an update that stopped after the commit to template-sources', async () => {
		const file = join(await tempDir(), 'git.db');
		const first = workspaceOver(file);
		await first.workspace.git?.use(ANALYST, (env) => env.list());
		await first.workspace.dispose();
		const store = sqliteGitStorage(file).open();
		const server = openServer({ storage: store.storage, secret: SECRET });
		const { hash } = await server.commit('template-sources/blank', {
			files: { 'README.md': 'updated\n' },
			message: 'Register the template blank\n',
			author: { name: 'ambion', email: 'ambion@ambion.invalid' },
			branch: 'main',
		});
		await server.close();
		store.close();
		const { workspace } = workspaceOver(file, {
			templates: { blank: { source: { 'README.md': 'updated\n' } } },
		});
		const template = await workspace.git?.use(ANALYST, (env) => env.get('templates/blank'));
		expect(template?.branches.main).toBe(hash);
	});

	it('keeps template-sources to itself: no agent lists, reads, forks, or takes the name', async () => {
		const { git, workspace } = workspaceOver(join(await tempDir(), 'git.db'));
		const template = await workspace.git?.use(ANALYST, (env) => env.get('templates/blank'));
		const head = template?.branches.main ?? '';
		const hidden = await workspace.git?.use(ANALYST, async (env) => ({
			list: (await env.list()).map((repository) => repository.id),
			get: await env.get('template-sources/blank'),
			resolve: await env.resolve('template-sources/blank', { branch: 'main' }),
			show: await env.show('template-sources/blank', head),
			fork: await env.fork('template-sources/blank', 'y'),
		}));
		expect(hidden).toEqual({
			list: ['templates/blank'],
			get: undefined,
			resolve: undefined,
			show: undefined,
			fork: { ok: false, reason: 'no_source', source: 'template-sources/blank' },
		});
		const url = `${git.access.prefix}template-sources/blank`;
		expect(await git.access.credentialFor(ANALYST, url)).toBeUndefined();
		const reserved = { name: 'template-sources' };
		const refusal = "The name 'template-sources' is reserved by the git backend.";
		await expect(workspace.git?.use(reserved, (env) => env.list())).rejects.toThrow(refusal);
		await expect(git.access.credentialFor(reserved, url)).rejects.toThrow(refusal);
	});

	it('gives no credential that a shell variable can replace', async () => {
		const { workspace } = workspaceOver(join(await tempDir(), 'git.db'));
		const forked = await workspace.git?.use(ANALYST, (env) => env.fork('templates/blank', 'mine'));
		if (!forked?.ok) throw new Error('the fork was refused');
		const stolen = signToken(SECRET, {
			agent: 'analyst',
			repository: 'analyst/mine',
			scope: 'write',
			expiresAt: Date.now() + 60_000,
		});
		const clone = await sh(workspace, REVIEWER, `git clone ${forked.repository.url} ~/theirs`);
		expect(clone.code, clone.output).toBe(0);
		const commit = await sh(
			workspace,
			REVIEWER,
			'cd ~/theirs && echo y > y && git add y && git commit -m y',
		);
		expect(commit.code, commit.output).toBe(0);
		const pushed = await sh(
			workspace,
			REVIEWER,
			`cd ~/theirs && GIT_HTTP_BEARER_TOKEN=${stolen} git push origin main`,
		);
		expect(pushed.code).not.toBe(0);
		const after = await workspace.git?.use(ANALYST, (env) => env.get('analyst/mine'));
		expect(after?.branches.main).toBe(forked.repository.branches.main);
	});

	it('refuses a fork name outside the rule, and a credentialTtl that is not finite', async () => {
		const { workspace } = workspaceOver(join(await tempDir(), 'git.db'));
		const refused = await workspace.git?.use(ANALYST, (env) =>
			env.fork('templates/blank', 'Bad Name'),
		);
		expect(refused).toEqual({
			ok: false,
			reason: 'refused',
			message: "'Bad Name' is not a valid name.",
		});
		for (const credentialTtl of [Number.POSITIVE_INFINITY, 0, Number.NaN]) {
			expect(() =>
				justGitBackend({ storage: sqliteGitStorage(':memory:'), secret: SECRET, credentialTtl }),
			).toThrow('credentialTtl must be a finite number above 0.');
		}
	});

	it('opens nothing after dispose', async () => {
		const { git, workspace } = workspaceOver(join(await tempDir(), 'git.db'));
		await workspace.git?.use(ANALYST, (env) => env.list());
		await workspace.dispose();
		await expect(
			git.access.credentialFor(ANALYST, 'http://git.ambion.invalid/templates/blank'),
		).rejects.toThrow('The git backend is disposed.');
	});

	it('refuses a token on a path that names another repository', async () => {
		const { git, workspace } = workspaceOver(join(await tempDir(), 'git.db'));
		await workspace.git?.use(ANALYST, (env) => env.fork('templates/blank', 'mine'));
		const credential = await git.access.credentialFor(
			ANALYST,
			'http://git.ambion.invalid/analyst/mine',
		);
		const probe = (path: string) =>
			git.access.fetch(`http://git.ambion.invalid/${path}/info/refs?service=git-upload-pack`, {
				headers: { Authorization: `Bearer ${credential?.token}` },
			});
		// The token check and the server decode a path the same way, so both name one repository.
		for (const path of ['analyst/mine', 'analyst/%6Dine']) {
			expect((await probe(path)).status).toBe(200);
		}
		for (const path of ['analyst/mine.git', 'templates/blank', 'analyst/mine%2Fx']) {
			expect((await probe(path)).status).toBe(403);
		}
	});

	it('registers a template from a directory, and skips .git', async () => {
		const dir = await tempDir();
		await mkdir(join(dir, 'template/src'), { recursive: true });
		await mkdir(join(dir, 'template/.git'), { recursive: true });
		await writeFile(join(dir, 'template/src/main.ts'), 'export {};\n');
		await writeFile(join(dir, 'template/.git/HEAD'), 'ignored\n');
		const { workspace } = workspaceOver(join(dir, 'git.db'), {
			templates: { app: { source: fromDirectory(join(dir, 'template')), description: 'An app.' } },
		});
		const url = (await workspace.git?.use(ANALYST, (env) => env.get('templates/app')))?.url;
		const listed = await sh(
			workspace,
			ANALYST,
			`git clone ${url} ~/app && cd ~/app && ls -a src && ls -a`,
		);
		expect(listed.code, listed.output).toBe(0);
		expect(listed.output).toContain('main.ts');
		const head = await sh(workspace, ANALYST, 'cd ~/app && git log --oneline');
		expect(head.output.trim().split('\n')).toHaveLength(1);
	});
});
