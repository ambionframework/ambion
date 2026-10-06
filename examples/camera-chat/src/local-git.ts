import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type {
	GitBackend,
	GitCommit,
	GitEnv,
	GitForkOutcome,
	GitRepository,
	SourceFiles,
} from '@ambionframework/workspace';
import { fromDirectory } from '@ambionframework/workspace';
import {
	assertAgent,
	assertCommitHash,
	byPath,
	namespaceOf,
	type RegistrationSteps,
	registerRepositories,
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
		const description = await describedAs(path);
		return {
			id,
			url: path,
			defaultBranch,
			branches,
			...(source ? { source } : {}),
			...(description ? { description } : {}),
		};
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

	await registerRepositories(localSteps(pathOf), {
		templates: {
			camera: {
				source: fromDirectory(fileURLToPath(new URL('../templates/camera', import.meta.url))),
			},
			'camera-notes': {
				source: {
					'README.md': '# Camera notes\n\nSave observations and their evidence references here.\n',
				},
			},
		},
	});
	await protect(pathOf('templates/camera-notes'));
	await protect(pathOf('templates/camera'));
	return {
		label: 'localhost (local bare repositories)',
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

const AUTHOR = { name: 'Camera Chat', email: 'camera@localhost' };
const MAIN = 'refs/heads/main';

/** Write `files` under `directory`. */
async function writeFiles(directory: string, files: SourceFiles): Promise<void> {
	await mkdir(directory, { recursive: true });
	for (const [path, bytes] of Object.entries(files)) {
		const target = join(directory, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, bytes);
	}
}

/** Run `work` with an empty temporary directory, and remove the directory after it. */
async function inTemporary<T>(work: (directory: string) => Promise<T>): Promise<T> {
	const directory = await mkdtemp(join(tmpdir(), 'camera-template-'));
	try {
		return await work(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** The description of a template, or an empty string. */
const describedAs = (repository: string) =>
	git(repository, ['config', '--get', 'ambion.description']).catch(() => '');

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/**
 * Registration steps over the local bare repositories. A new template is a
 * bare clone of a commit of the source. A changed template takes a commit of
 * the source on its tip. The commit goes in with plumbing, so the
 * `pre-receive` hook that refuses a push does not run.
 */
function localSteps(pathOf: (id: string) => string): RegistrationSteps {
	const unused = async (): Promise<never> => {
		throw new Error('This backend registers no shared repository.');
	};
	async function describe(repository: string, description: string | undefined): Promise<void> {
		if ((await describedAs(repository)) === (description ?? '')) return;
		if (description === undefined)
			await git(repository, ['config', '--unset', 'ambion.description']);
		else await git(repository, ['config', 'ambion.description', description]);
	}
	return {
		async template(name, description) {
			const repository = pathOf(`templates/${name}`);
			if (!(await exists(repository))) return undefined;
			await describe(repository, description);
			const listing = await git(repository, ['ls-tree', '-r', '-z', 'main']).catch(() => '');
			return new Map(
				listing
					.split('\0')
					.filter(Boolean)
					.map((line) => {
						const [facts = '', path = ''] = line.split('\t');
						return [path, facts.split(' ')[2] ?? ''] as const;
					}),
			);
		},
		async createTemplate(name, files, description) {
			const repository = pathOf(`templates/${name}`);
			await inTemporary(async (checkout) => {
				await git(checkout, ['init', '-b', 'main']);
				await writeFiles(checkout, files);
				await git(checkout, ['add', '.']);
				await git(checkout, [
					'-c',
					`user.name=${AUTHOR.name}`,
					'-c',
					`user.email=${AUTHOR.email}`,
					'commit',
					'-m',
					`Register the template ${name}`,
				]);
				await mkdir(dirname(repository), { recursive: true });
				await execute('git', ['clone', '--bare', checkout, repository]);
			});
			await describe(repository, description);
		},
		async updateTemplate(name, files, description) {
			const repository = pathOf(`templates/${name}`);
			const tip = await git(repository, ['rev-parse', '--verify', MAIN]);
			await inTemporary(async (scratch) => {
				const tree = join(scratch, 'files');
				await writeFiles(tree, files);
				const env = {
					...process.env,
					GIT_INDEX_FILE: join(scratch, 'index'),
					GIT_AUTHOR_NAME: AUTHOR.name,
					GIT_AUTHOR_EMAIL: AUTHOR.email,
					GIT_COMMITTER_NAME: AUTHOR.name,
					GIT_COMMITTER_EMAIL: AUTHOR.email,
				};
				const run = async (args: string[]) =>
					(
						await execute('git', ['--git-dir', repository, '--work-tree', tree, ...args], {
							cwd: tree,
							env,
						})
					).stdout.trim();
				await run(['add', '-A']);
				const commit = await run([
					'commit-tree',
					await run(['write-tree']),
					'-p',
					tip,
					'-m',
					`Register the template ${name}`,
				]);
				await run(['update-ref', MAIN, commit, tip]);
			});
			await describe(repository, description);
		},
		shared: unused,
		seedShared: unused,
	};
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
