/**
 * `workstationGitBackend` on the scripted tier: the options it refuses, the
 * preparation of the git account, template registration by rename, and
 * the list, get, and fork scripts. The test server runs each script as
 * the user that runs the test, in the home of `lab-git` on the local disk.
 * `serve` and the key lines have files of their own.
 */

import { cp, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type WorkstationGitOptions, workstationGitBackend } from '../src/index.ts';
import { git, gitBackend, gitServer, hasGitTools } from './support/git.ts';

const ANALYST = { name: 'analyst' };
const REVIEWER = { name: 'reviewer' };

const FINGERPRINT = `SHA256:${'A'.repeat(43)}`;
const ACCOUNT = { username: 'lab-git', privateKey: 'unused' };

describe('the options of workstationGitBackend', () => {
	it.each<[string, Partial<WorkstationGitOptions>, RegExp]>([
		['a host key that is no fingerprint', { hostKey: 'ssh-ed25519 AAAA' }, /hostKey/],
		['port 0', { port: 0 }, /port/],
		['a root that starts with a dot', { root: '.repos' }, /root/],
		['a root that leaves the home', { root: '../repos' }, /root/],
		['an alias with a space', { alias: 'ambion git' }, /alias/],
		['a key life of 0', { keyTtl: 0 }, /keyTtl/],
		['a key life that is not whole seconds', { keyTtl: 1.5 }, /keyTtl/],
	])('refuses %s', (_name, change, message) => {
		const options = { host: 'lab.internal', hostKey: FINGERPRINT, account: ACCOUNT, ...change };
		expect(() => workstationGitBackend(options)).toThrow(message);
	});
});

/** The mode bits of `path`. */
const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe.skipIf(!hasGitTools)('workstationGitBackend', () => {
	it('prepares the account, and registers each template with its description and its hook', async () => {
		const { home, options } = await gitServer();
		const env = await gitBackend(options).connect(ANALYST);
		const listed = await env.list();

		expect(await modeOf(join(home, '.ambion'))).toBe(0o700);
		expect(await modeOf(join(home, '.ssh'))).toBe(0o700);
		expect(await modeOf(join(home, '.ambion', 'serve'))).toBe(0o700);
		expect(await readdir(join(home, 'repos', '.staging'))).toEqual([]);
		expect(listed.map((repository) => repository.id)).toEqual([
			'templates/blank',
			'templates/weekly-report',
		]);
		const [blank, report] = listed;
		expect(blank).toEqual({
			id: 'templates/blank',
			url: 'ssh://ambion-git/templates/blank',
			defaultBranch: 'main',
			branches: { main: expect.stringMatching(/^[0-9a-f]{40}$/) },
		});
		expect(report?.description).toBe('A weekly status report.');
		const template = join(home, 'repos', 'templates', 'weekly-report.git');
		expect(git(template, 'show', 'main:data/numbers.csv')).toBe('a,b\n1,2\n');
		expect(git(template, 'log', '-1', '--format=%an %s', 'main')).toBe(
			'ambion Register the template weekly-report\n',
		);
		expect(git(template, 'config', 'core.logAllRefUpdates')).toBe('always\n');
		expect(await modeOf(join(template, 'hooks', 'pre-receive'))).toBe(0o755);
		expect(await env.list('templates')).toEqual(listed);
		expect(await env.list('analyst')).toEqual([]);
	});

	it('refuses every push to a template through its hook', async () => {
		const { home, options } = await gitServer();
		await (await gitBackend(options).connect(ANALYST)).list();
		const clone = join(home, 'clone');
		git(home, 'clone', '--quiet', join(home, 'repos', 'templates', 'blank.git'), clone);
		git(clone, '-c', 'user.name=a', '-c', 'user.email=a@b', 'commit', '--allow-empty', '-m', 'x');
		expect(() => git(clone, 'push', 'origin', 'main')).toThrow(/a template is read-only/);
	});

	it('writes serve again only when its content differs', async () => {
		const { home, options } = await gitServer();
		const serve = join(home, '.ambion', 'serve');
		await gitBackend(options).connect(ANALYST);
		const first = await stat(serve);
		await gitBackend(options).connect(ANALYST);
		expect((await stat(serve)).ino).toBe(first.ino);
		const text = await readFile(serve, 'utf8');
		await writeFile(serve, 'stale\n');
		await gitBackend(options).connect(ANALYST);
		expect(await readFile(serve, 'utf8')).toBe(text);
		expect(await modeOf(serve)).toBe(0o700);
	});

	it('removes each staging folder older than one hour, and keeps a newer one', async () => {
		const { home, options } = await gitServer();
		const staging = join(home, 'repos', '.staging');
		await mkdir(join(staging, 'old', 'objects'), { recursive: true });
		await mkdir(join(staging, 'new'), { recursive: true });
		const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
		await utimes(join(staging, 'old'), twoHoursAgo, twoHoursAgo);
		await gitBackend(options).connect(ANALYST);
		expect(await readdir(staging)).toEqual(['new']);
	});

	it('writes nothing for a template with the same source, and fast-forwards a changed one', async () => {
		const { home, options } = await gitServer();
		const blank = async (backend: ReturnType<typeof gitBackend>) =>
			(await backend.connect(ANALYST)).get('templates/blank');
		const before = (await blank(gitBackend(options)))?.branches.main;
		expect(before).toMatch(/^[0-9a-f]{40}$/);
		expect((await blank(gitBackend(options)))?.branches.main).toBe(before);
		const changed: WorkstationGitOptions = {
			...options,
			templates: {
				...options.templates,
				blank: { description: 'An empty start.', source: { 'NOTES.md': 'changed\n' } },
			},
		};
		const updated = await blank(gitBackend(changed));
		expect(updated?.description).toBe('An empty start.');
		const repo = join(home, 'repos', 'templates', 'blank.git');
		expect(git(repo, 'rev-parse', 'main~1').trim()).toBe(before);
		expect(git(repo, 'ls-tree', '-r', '--name-only', 'main')).toBe('NOTES.md\n');
		expect(await readdir(join(home, 'repos', '.staging'))).toEqual([]);
		expect((await blank(gitBackend(changed)))?.branches.main).toBe(updated?.branches.main);
	});

	it.each<[string, WorkstationGitOptions['templates'], RegExp]>([
		['an invalid name', { 'Weekly Report': { source: {} } }, /'Weekly Report' is not a valid/],
		['a path that leaves its root', { bad: { source: { '../x': 'y' } } }, /leaves its root/],
	])('refuses a template with %s', async (_name, templates, message) => {
		const { options } = await gitServer();
		const backend = gitBackend({ ...options, templates });
		await expect(backend.connect(ANALYST)).rejects.toThrow(message);
		// A failed preparation lets the next call try again, and it fails the same way.
		await expect(backend.access.identityFor(ANALYST)).rejects.toThrow(message);
	});

	it('lands a fork with one rename, with its source in its config and its objects hard-linked', async () => {
		const { home, options } = await gitServer();
		const env = await gitBackend(options).connect(ANALYST);
		const template = await env.get('templates/weekly-report');
		const outcome = await env.fork('templates/weekly-report', 'report');

		expect(outcome).toEqual({
			ok: true,
			repository: {
				id: 'analyst/report',
				url: 'ssh://ambion-git/analyst/report',
				source: 'templates/weekly-report',
				defaultBranch: 'main',
				branches: { main: template?.branches.main },
			},
		});
		expect(await readdir(join(home, 'repos', '.staging'))).toEqual([]);
		const fork = join(home, 'repos', 'analyst', 'report.git');
		expect(git(fork, 'config', 'ambion.source')).toBe('templates/weekly-report\n');
		expect(git(fork, 'config', 'core.logAllRefUpdates')).toBe('always\n');
		expect(git(fork, 'remote')).toBe('');
		const head = template?.branches.main ?? '';
		const object = join(fork, 'objects', head.slice(0, 2), head.slice(2));
		expect((await stat(object)).nlink).toBeGreaterThan(1);
		expect(await env.list('analyst')).toEqual(outcome.ok ? [outcome.repository] : []);

		const review = await (
			await gitBackend(options).connect(REVIEWER)
		).fork('analyst/report', 'review');
		expect(review.ok && review.repository.source).toBe('analyst/report');
	});

	it('keeps template-sources hidden from list, get, and fork', async () => {
		const { home, options } = await gitServer();
		const env = await gitBackend(options).connect(ANALYST);
		await mkdir(join(home, 'repos', 'template-sources'));
		await cp(
			join(home, 'repos', 'templates', 'blank.git'),
			join(home, 'repos', 'template-sources', 'blank.git'),
			{ recursive: true },
		);
		expect((await env.list()).map((repository) => repository.id)).toEqual([
			'templates/blank',
			'templates/weekly-report',
		]);
		expect(await env.get('template-sources/blank')).toBeUndefined();
		expect(await env.fork('template-sources/blank', 'x')).toEqual({
			ok: false,
			reason: 'no_source',
			source: 'template-sources/blank',
		});
	});

	it('refuses a missing source, a bad name, and an aborted fork, and a repeated fork after an abort is safe', async () => {
		const { options } = await gitServer();
		const env = await gitBackend(options).connect(ANALYST);
		expect(await env.fork('templates/none', 'x')).toEqual({
			ok: false,
			reason: 'no_source',
			source: 'templates/none',
		});
		expect(await env.fork('templates/blank', 'Bad Name')).toMatchObject({
			ok: false,
			reason: 'refused',
		});
		await expect(env.fork('templates/blank', 'cut', AbortSignal.abort())).rejects.toThrow();
		expect(await env.fork('templates/blank', 'cut')).toMatchObject({ ok: true });
	});

	it('keeps one fork of one name, in one process and across two', async () => {
		const { home, options } = await gitServer();
		const first = gitBackend(options);
		const second = gitBackend(options);
		const kinds = async (
			forks: Promise<{ ok: true } | { ok: false; reason: string }>[],
		): Promise<string[]> =>
			(await Promise.all(forks)).map((outcome) => (outcome.ok ? 'ok' : outcome.reason)).sort();

		const one = await first.connect(ANALYST);
		const other = await first.connect(ANALYST);
		expect(
			await kinds([one.fork('templates/blank', 'twin'), other.fork('templates/blank', 'twin')]),
		).toEqual(['name_taken', 'ok']);
		const across = await second.connect(ANALYST);
		expect(
			await kinds([one.fork('templates/blank', 'pair'), across.fork('templates/blank', 'pair')]),
		).toEqual(['name_taken', 'ok']);
		const taken = await across.fork('templates/weekly-report', 'twin');
		expect(taken.ok === false && taken.reason === 'name_taken' && taken.repository.source).toBe(
			'templates/blank',
		);
		expect(await readdir(join(home, 'repos', '.staging'))).toEqual([]);
		expect((await one.list('analyst')).map((repository) => repository.id)).toEqual([
			'analyst/pair',
			'analyst/twin',
		]);
	});

	it('keeps one client while it is in use, and opens a new one after idleTimeout or a drop', async () => {
		const { server, options } = await gitServer();
		const env = await gitBackend({ ...options, idleTimeout: 0.3 }).connect(ANALYST);
		await Promise.all([env.list(), env.get('templates/blank'), env.list('templates')]);
		expect(server.logins.get('lab-git')).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 600));
		await env.list();
		expect(server.logins.get('lab-git')).toBe(2);
		server.dropClients();
		await new Promise((resolve) => setTimeout(resolve, 200));
		await env.list();
		expect(server.logins.get('lab-git')).toBe(3);
	});

	it('refuses an agent with a reserved name, and every call after dispose', async () => {
		const { options } = await gitServer();
		const backend = gitBackend(options);
		for (const name of ['templates', 'template-sources', 'Analyst']) {
			await expect(backend.connect({ name })).rejects.toThrow(`'${name}'`);
		}
		await backend.dispose?.();
		await expect(backend.connect(ANALYST)).rejects.toThrow(/disposed/);
	});
});
