/**
 * What `gitBackend` holds beyond the conformance cases: the tokens, the
 * registration after a crash, a restart over one file, a shell variable that
 * tries to carry a token, the templates from a directory, and a real `git`
 * over HTTP.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace, type Workspace } from '@ambionframework/workspace';
import { afterEach, describe, expect, it } from 'vitest';
import { fromDirectory, gitBackend, sqliteGitStorage } from '../src/index.ts';
import { openServer } from '../src/server.ts';
import { signToken, tokenOf, verifyToken } from '../src/tokens.ts';
import { SECRET } from './support/harness.ts';

const run = promisify(execFile);
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

function workspaceOver(file: string, options: Partial<Parameters<typeof gitBackend>[0]> = {}) {
	const git = gitBackend({
		storage: sqliteGitStorage(file),
		secret: SECRET,
		templates: TEMPLATES,
		...options,
	});
	const workspace = openWorkspace({ name: 'git-test', backend: { bash: memoryBackend(), git } });
	cleanup.push(() => workspace.dispose());
	return { git, workspace };
}

async function sh(workspace: Workspace, agent: { name: string }, command: string) {
	let output = '';
	const ran = await workspace.use(agent, (env) =>
		env.exec(
			command,
			{
				capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
				onUpdate: (update) => {
					if (update.kind === 'replace') output = update.output.text;
				},
			},
			BACKGROUND_CONTEXT,
		),
	);
	if (!ran.ok) throw ran.error;
	return { code: ran.value.exitCode, output };
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

describe('gitBackend', () => {
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
		const server = openServer({ storage: store.storage, secret: SECRET, basePath: '' });
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
		await sh(workspace, REVIEWER, `git clone ${forked.repository.url} ~/theirs`);
		const pushed = await sh(
			workspace,
			REVIEWER,
			`cd ~/theirs && echo y > y && git add y && git commit -m y && GIT_HTTP_BEARER_TOKEN=${stolen} git push origin main`,
		);
		expect(pushed.code).not.toBe(0);
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

describe('a real git over HTTP', () => {
	it('clones with the credential file, pushes its own fork, and is refused on a template', async () => {
		const dir = await tempDir();
		const http = createServer();
		const port = await new Promise<number>((resolve) =>
			http.listen(0, '127.0.0.1', () => resolve((http.address() as AddressInfo).port)),
		);
		cleanup.push(() => new Promise((resolve) => http.close(resolve)));
		const { git, workspace } = workspaceOver(join(dir, 'git.db'), {
			url: `http://127.0.0.1:${port}/git`,
		});
		http.on('request', git.handler);
		await workspace.git?.use(ANALYST, (env) => env.fork('templates/blank', 'real'));
		const credentials = await git.access.credentialsFor(ANALYST);
		const lines = credentials.map((credential) => {
			const url = new URL(credential.url);
			return `${url.protocol}//ambion:${credential.token}@${url.host}${url.pathname}`;
		});
		await writeFile(join(dir, 'credentials'), `${lines.join('\n')}\n`, { mode: 0o600 });
		const env = {
			...process.env,
			HOME: dir,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_TERMINAL_PROMPT: '0',
			GIT_AUTHOR_NAME: 'analyst',
			GIT_AUTHOR_EMAIL: 'analyst@ambion.invalid',
			GIT_COMMITTER_NAME: 'analyst',
			GIT_COMMITTER_EMAIL: 'analyst@ambion.invalid',
		};
		const gitArgs = [
			'-c',
			`credential.helper=store --file=${join(dir, 'credentials')}`,
			'-c',
			'credential.useHttpPath=true',
		];
		const real = (args: string[], cwd = dir) => run('git', [...gitArgs, ...args], { cwd, env });
		const fork = `http://127.0.0.1:${port}/git/analyst/real`;
		await real(['clone', fork, 'real']);
		await writeFile(join(dir, 'real/new.txt'), 'new\n');
		await real(['add', 'new.txt'], join(dir, 'real'));
		await real(['commit', '-m', 'new'], join(dir, 'real'));
		await real(['push', 'origin', 'main'], join(dir, 'real'));
		const after = await workspace.git?.use(ANALYST, (env) => env.get('analyst/real'));
		const log = await real(['log', '-1', '--format=%H'], join(dir, 'real'));
		expect(after?.branches.main).toBe(log.stdout.trim());
		await real(['clone', `http://127.0.0.1:${port}/git/templates/blank`, 'blank']);
		await writeFile(join(dir, 'blank/x.txt'), 'x\n');
		await real(['add', 'x.txt'], join(dir, 'blank'));
		await real(['commit', '-m', 'x'], join(dir, 'blank'));
		await expect(real(['push', 'origin', 'main'], join(dir, 'blank'))).rejects.toThrow();
		expect(await readFile(join(dir, 'credentials'), 'utf8')).toContain('analyst/real');
	});
});
