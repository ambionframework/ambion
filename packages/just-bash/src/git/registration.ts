/**
 * The storage steps of registration over the registry and the `just-git`
 * server. `registerRepositories` of the workspace holds the decisions and
 * calls these steps. Each step finishes what a crash left.
 *
 * A template has two repositories. The step writes the source to
 * `template-sources/<name>`, because a fork reads its objects from the root
 * of its fork tree. A new template forks from that commit to
 * `templates/<name>`. A changed template fast-forwards to it. A fork of the
 * template then reads the new objects. A fork made before the update keeps
 * its own refs.
 *
 * A crash between the steps of a write leaves a state that the same step
 * finishes at the next registration. A `forking` row of a shared
 * repository that holds its commit becomes `ready` without a new seed.
 */

import type { SourceFiles } from '@ambionframework/workspace';
import {
	BACKEND_AUTHOR,
	changeTo,
	DEFAULT_BRANCH,
	hashesOf,
	namespaceOf,
	type RegistrationSteps,
	SHARED,
	sameFiles,
	TEMPLATES,
} from '@ambionframework/workspace/git';
import { flattenTree, type GitRepo, readCommit, readHead } from 'just-git/repo';
import type { GitServer } from 'just-git/server';
import type { OpenGitStorage, RegistryRow } from './storage.ts';
import type { TokenClaims } from './tokens.ts';

/**
 * The namespace of the source of each template. It is a storage detail of
 * this backend: no agent takes the name, and no agent reaches a repository
 * in it.
 */
export const SOURCES = 'template-sources';

/** Each path at the tip of the default branch of `repo`, with its blob hash. Empty for an unborn branch. */
async function tipHashes(repo: GitRepo): Promise<ReadonlyMap<string, string>> {
	const head = await readHead(repo);
	if (head.hash === null) return new Map();
	const commit = await readCommit(repo, head.hash);
	const entries = await flattenTree(repo, commit.tree);
	return new Map(entries.map((entry) => [entry.path, entry.hash]));
}

/**
 * The row of `id` after a crash is settled: a `forking` row whose
 * repository exists becomes `ready`, and one whose repository does not
 * exist goes. Only a caller that knows no fork of `id` is in flight calls
 * it: registration, and `settleAll` before the first operation.
 */
async function settledRow(store: OpenGitStorage, id: string): Promise<RegistryRow | undefined> {
	const row = store.registry.get(id);
	if (row === undefined || row.state === 'ready') return row;
	if (await store.storage.hasRepo(id)) {
		store.registry.ready(id);
		return { ...row, state: 'ready' };
	}
	store.registry.remove(id);
	return undefined;
}

/**
 * Settle every `forking` row that a crash left. It runs once, before the
 * first operation of the backend, when no fork is in flight.
 */
export async function settleAll(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
): Promise<void> {
	for (const row of store.registry.all()) {
		if (row.state !== 'forking') continue;
		if (namespaceOf(row.id) !== SHARED) {
			await settledRow(store, row.id);
			continue;
		}
		// A committed seed is complete even if the ready marker was interrupted.
		// Unborn shared repos stay hidden for a configured registration to finish.
		if (!(await store.storage.hasRepo(row.id))) {
			store.registry.remove(row.id);
			continue;
		}
		const repo = await server.requireRepo(row.id);
		if ((await readHead(repo)).hash !== null) store.registry.ready(row.id);
	}
}

/**
 * Whether the shared repository is published. A `ready` row is published,
 * and an interrupted seed that holds its commit finishes here. Each case
 * writes the description.
 */
async function sharedPublished(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	description: string | undefined,
): Promise<boolean> {
	const id = `${SHARED}/${name}`;
	const row = store.registry.get(id);
	if (row?.state === 'ready') {
		if (row.description !== description) store.registry.describe(id, description);
		if ((await server.repo(id)) === null)
			throw new Error(`The shared repository '${name}' is registered but missing from storage.`);
		return true;
	}
	return completeInterruptedSharedSeed(store, server, id, row, description);
}

async function completeInterruptedSharedSeed(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	id: string,
	row: RegistryRow | undefined,
	description: string | undefined,
): Promise<boolean> {
	if (row?.state !== 'forking' || !(await store.storage.hasRepo(id))) return false;
	const repo = await server.requireRepo(id);
	if ((await readHead(repo)).hash === null) return false;
	// The initial commit is the publication boundary. A crash may have
	// happened just before the ready marker, so finish without changing the seed.
	store.registry.describe(id, description);
	store.registry.ready(id);
	return true;
}

async function seedSharedRepository(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	id: string,
	files: SourceFiles,
): Promise<void> {
	if (!(await store.storage.hasRepo(id)))
		await server.createRepo(id, { defaultBranch: DEFAULT_BRANCH });
	const repo = await server.requireRepo(id);
	const head = await readHead(repo);
	const tip = await tipHashes(repo);
	const wanted = hashesOf(files);
	if (head.hash === null || !sameFiles(tip, wanted)) {
		await server.commit(id, {
			files: changeTo(files, tip),
			message: `Register the shared repository ${name}\n`,
			author: BACKEND_AUTHOR,
			branch: DEFAULT_BRANCH,
		});
	}
}

/** Make the tip of `template-sources/<name>` hold `files`, and give the repository and its tip. */
async function commitSource(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	files: SourceFiles,
): Promise<{ readonly id: string; readonly head: string | null }> {
	const id = `${SOURCES}/${name}`;
	if (!(await store.storage.hasRepo(id))) {
		await server.createRepo(id, { defaultBranch: DEFAULT_BRANCH });
	}
	const repo = await server.requireRepo(id);
	const tip = await tipHashes(repo);
	if (sameFiles(tip, hashesOf(files))) return { id, head: (await readHead(repo)).hash };
	const { hash } = await server.commit(id, {
		files: changeTo(files, tip),
		message: `Register the template ${name}\n`,
		author: BACKEND_AUTHOR,
		branch: DEFAULT_BRANCH,
	});
	return { id, head: hash };
}

/** Move the default branch of `templates/<name>` from `from` to `to`, or fail with the template's name. */
async function fastForward(
	server: GitServer<TokenClaims>,
	name: string,
	from: string | null,
	to: string | null,
): Promise<void> {
	if (to === null) throw new Error(`The source of the template '${name}' has no commit.`);
	const { refResults } = await server.updateRefs(`${TEMPLATES}/${name}`, [
		{ ref: `refs/heads/${DEFAULT_BRANCH}`, newHash: to, oldHash: from },
	]);
	const refused = refResults.find((result) => !result.ok);
	if (refused !== undefined) {
		throw new Error(`The template '${name}' did not move to its new source: ${refused.error}`);
	}
}

/** The storage steps of registration over the registry and the `just-git` server. */
export function registrationSteps(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
): RegistrationSteps {
	return {
		template: async (name, description) => {
			const id = `${TEMPLATES}/${name}`;
			const row = await settledRow(store, id);
			if (row !== undefined && row.description !== description) {
				store.registry.describe(id, description);
			}
			const existing = row === undefined ? null : await server.repo(id);
			return existing === null ? undefined : tipHashes(existing);
		},
		createTemplate: async (name, files, description) => {
			const id = `${TEMPLATES}/${name}`;
			const source = await commitSource(store, server, name, files);
			if (store.registry.get(id) === undefined) store.registry.begin(id, undefined, description);
			await server.forkRepo(source.id, id);
			store.registry.ready(id);
		},
		updateTemplate: async (name, files) => {
			const source = await commitSource(store, server, name, files);
			const existing = await server.requireRepo(`${TEMPLATES}/${name}`);
			await fastForward(server, name, (await readHead(existing)).hash, source.head);
		},
		shared: (name, description) => sharedPublished(store, server, name, description),
		seedShared: async (name, files, description) => {
			const id = `${SHARED}/${name}`;
			// A forking row is an interrupted seed. It needs no new row.
			if (store.registry.get(id) === undefined) store.registry.begin(id, undefined, description);
			await seedSharedRepository(store, server, name, id, files);
			store.registry.describe(id, description);
			store.registry.ready(id);
		},
	};
}
