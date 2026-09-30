import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
	GitBackend,
	GitCommit,
	GitEnv,
	GitForkOutcome,
	GitRepository,
} from '@ambionframework/workspace';
import {
	assertAgent,
	assertCommitHash,
	byPath,
	namespaceOf,
	revisionOf,
	validName,
} from '@ambionframework/workspace/git';

const execute = promisify(execFile);
async function git(path: string, args: string[], signal?: AbortSignal): Promise<string> {
	return (
		await execute('git', ['-C', path, ...args], { signal, maxBuffer: 4 * 1024 * 1024 })
	).stdout.trim();
}

/** Bare repositories on localhost. All callers share the current macOS account. */
export async function localGitBackend(directory: string): Promise<GitBackend> {
	const root = resolve(directory);
	await mkdir(root, { recursive: true });
	const pathOf = (id: string) => {
		if (!namespaceOf(id)) throw new Error('Invalid repository identifier.');
		return join(root, `${id}.git`);
	};
	async function get(id: string, signal?: AbortSignal): Promise<GitRepository | undefined> {
		const path = pathOf(id);
		try {
			await readdir(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
		const refs = await git(
			path,
			['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'],
			signal,
		);
		const branches = Object.fromEntries(
			refs
				.split('\n')
				.filter(Boolean)
				.map((line) => line.split(' ')),
		);
		const defaultBranch = await git(path, ['symbolic-ref', '--short', 'HEAD'], signal);
		const source = await git(path, ['config', '--get', 'ambion.source'], signal).catch(() => '');
		return { id, url: path, defaultBranch, branches, ...(source ? { source } : {}) };
	}
	async function listNamespace(space: string, signal?: AbortSignal) {
		if (!namespaceOf(`${space}/notes`)) return [];
		const names = await readdir(join(root, space)).catch(() => []);
		const found = await Promise.all(
			names
				.filter((name) => name.endsWith('.git'))
				.map((name) => get(`${space}/${name.slice(0, -4)}`, signal)),
		);
		return found.filter((item): item is GitRepository => item !== undefined);
	}
	async function list(namespace?: string, signal?: AbortSignal): Promise<GitRepository[]> {
		const spaces = namespace ? [namespace] : await readdir(root);
		const found = await Promise.all(spaces.map((space) => listNamespace(space, signal)));
		return found.flat().sort((a, b) => a.id.localeCompare(b.id));
	}
	async function show(
		id: string,
		hash: string,
		signal?: AbortSignal,
	): Promise<GitCommit | undefined> {
		assertCommitHash(hash);
		if (!(await get(id, signal))) return undefined;
		const path = pathOf(id);
		const data = await git(
			path,
			['show', '-s', '--format=%H%x00%B%x00%an%x00%ae%x00%aI%x00%P', hash],
			signal,
		).catch(() => undefined);
		if (!data) return undefined;
		const diff = await git(
			path,
			['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-z', '--no-renames', hash],
			signal,
		);
		return parseCommit(data, hash, diff);
	}

	async function fork(
		agent: { name: string },
		source: string,
		name: string,
		signal?: AbortSignal,
	): Promise<GitForkOutcome> {
		if (!validName(name))
			return { ok: false, reason: 'refused', message: 'Invalid repository name.' };
		const original = await get(source, signal);
		if (!original) return { ok: false, reason: 'no_source', source };
		const id = `${agent.name}/${name}`;
		const existing = await get(id, signal);
		if (existing) return { ok: false, reason: 'name_taken', repository: existing };
		await mkdir(join(root, agent.name), { recursive: true });
		await execute('git', ['clone', '--bare', '--no-hardlinks', original.url, pathOf(id)], {
			signal,
		});
		await git(pathOf(id), ['config', 'ambion.source', source], signal);
		const repository = await get(id, signal);
		if (!repository) throw new Error('The fork was not created.');
		return { ok: true, repository };
	}

	const template = 'templates/camera-notes';
	if (!(await get(template))) await seed(pathOf(template));
	if (!(await get('templates/camera')))
		await seed(
			pathOf('templates/camera'),
			fileURLToPath(new URL('../templates/camera', import.meta.url)),
		);
	await protect(pathOf(template));
	await protect(pathOf('templates/camera'));
	return {
		access: { transport: 'local-file' },
		server: 'localhost (local bare repositories)',
		async connect(agent, signal): Promise<GitEnv> {
			assertAgent(agent);
			signal?.throwIfAborted();
			return {
				list,
				get,
				show,
				cleanup: async () => {},
				async resolve(id, at, signal) {
					const revision = revisionOf(at);
					if (!(await get(id, signal))) return undefined;
					return git(pathOf(id), ['rev-parse', '--verify', `${revision}^{commit}`], signal).catch(
						() => undefined,
					);
				},
				fork: (source, name, signal) => fork(agent, source, name, signal),
			};
		},
	};
}

/** Refuse a push into a template. The trusted local shell can still remove the hook. */
async function protect(repository: string): Promise<void> {
	await writeFile(
		join(repository, 'hooks', 'pre-receive'),
		'#!/bin/sh\necho "A template is read-only. Fork it and push to the fork." >&2\nexit 1\n',
		{ mode: 0o755 },
	);
}

async function seed(destination: string, template?: string): Promise<void> {
	const checkout = await mkdtemp(join(tmpdir(), 'camera-notes-'));
	try {
		await git(checkout, ['init', '-b', 'main']);
		if (template) await cp(template, checkout, { recursive: true });
		else
			await writeFile(
				join(checkout, 'README.md'),
				'# Camera notes\n\nSave observations and their evidence references here.\n',
			);
		await git(checkout, ['add', '.']);
		await git(checkout, [
			'-c',
			'user.name=Camera Chat',
			'-c',
			'user.email=camera@localhost',
			'commit',
			'-m',
			'Seed template',
		]);
		await mkdir(resolve(destination, '..'), { recursive: true });
		await execute('git', ['clone', '--bare', checkout, destination]);
	} finally {
		await rm(checkout, { recursive: true, force: true });
	}
}

function parseCommit(data: string, hash: string, diff: string): GitCommit {
	const [full = hash, message = '', name = '', email = '', date = '', parents = ''] =
		data.split('\0');
	return {
		hash: full,
		message: message.trim(),
		author: { name, email, date },
		parents: parents.split(' ').filter(Boolean),
		changes: parseChanges(diff),
	};
}

function parseChanges(diff: string): GitCommit['changes'] {
	const tokens = diff.split('\0');
	const changes: GitCommit['changes'][number][] = [];
	for (let i = 0; i < tokens.length - 1; i += 2) {
		const status = tokens[i];
		changes.push({
			path: tokens[i + 1] ?? '',
			change: status === 'A' ? 'added' : status === 'D' ? 'deleted' : 'modified',
		});
	}
	return byPath(changes);
}
