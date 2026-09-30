/**
 * Template registration: idempotent, and it resumes after a crash.
 *
 * It runs once, before the first operation of the backend. For each
 * template it takes the first case that holds.
 *
 * 1. The template exists, and its tree equals the source. Nothing happens.
 * 2. The template exists, and its tree differs. `template-sources/<name>`
 *    gets the source at its tip, and `templates/<name>` fast-forwards to
 *    that commit.
 * 3. The template does not exist. `template-sources/<name>` gets the source
 *    at its tip, and the backend forks it to `templates/<name>`.
 *
 * The commit goes to `template-sources/<name>`, because a fork reads its
 * objects from the root of its fork tree. A fork of the template then reads
 * the new objects. A fork made before the update keeps its own refs.
 *
 * A crash between the steps of case 2 or case 3 leaves a state that the
 * same case finishes at the next registration.
 */

import type { SourceFiles } from '@ambionframework/workspace';
import {
	changeTo,
	filesOf,
	hashesOf,
	namespaceOf,
	type RepositoryRegistration,
	SHARED,
	sameFiles,
	TEMPLATES,
	validName,
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

/** The author of every commit that the backend writes. */
const BACKEND_AUTHOR = { name: 'ambion', email: 'ambion@ambion.invalid' };

/** The default branch of every repository that the backend creates. */
export const DEFAULT_BRANCH = 'main';

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

/** Register every template, in name order. */
export async function registerTemplates(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	templates: Readonly<Record<string, RepositoryRegistration>>,
): Promise<void> {
	for (const name of Object.keys(templates).sort()) {
		const registration = templates[name];
		if (registration !== undefined) await registerOne(store, server, name, registration);
	}
}

async function registerOne(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	if (!validName(name)) throw new Error(`'${name}' is not a valid template name.`);
	const files = await filesOf(registration);
	const wanted = hashesOf(files);
	const template = `${TEMPLATES}/${name}`;
	const row = await settledRow(store, template);
	if (row !== undefined && row.description !== registration.description) {
		store.registry.describe(template, registration.description);
	}
	const existing = row === undefined ? null : await server.repo(template);
	if (existing !== null && sameFiles(await tipHashes(existing), wanted)) return;
	const source = await commitSource(store, server, name, files);
	if (existing !== null) {
		await fastForward(server, name, (await readHead(existing)).hash, source.head);
		return;
	}
	if (row === undefined) store.registry.begin(template, undefined, registration.description);
	await server.forkRepo(source.id, template);
	store.registry.ready(template);
}

/** Register shared repositories without changing any repository already published. */
export async function registerShared(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	shared: Readonly<Record<string, RepositoryRegistration>>,
): Promise<void> {
	for (const name of Object.keys(shared).sort()) {
		const registration = shared[name];
		if (registration !== undefined) await registerSharedOne(store, server, name, registration);
	}
}

async function registerSharedOne(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	if (!validName(name)) throw new Error(`'${name}' is not a valid shared repository name.`);
	const id = `${SHARED}/${name}`;
	const row = store.registry.get(id);
	if (row?.state === 'ready') {
		await describeRegisteredShared(
			store,
			server,
			id,
			name,
			row.description,
			registration.description,
		);
		return;
	}
	if (await completeInterruptedSharedSeed(store, server, id, row, registration.description)) return;

	// A forking row is an interrupted initial seed. Only this unpublished
	// state reads the source; ready repositories above are description-only.
	const files = await filesOf(registration);
	if (row === undefined) store.registry.begin(id, undefined, registration.description);
	await seedSharedRepository(store, server, name, id, files);
	store.registry.describe(id, registration.description);
	store.registry.ready(id);
}

async function describeRegisteredShared(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	id: string,
	name: string,
	previousDescription: string | undefined,
	description: string | undefined,
): Promise<void> {
	if (previousDescription !== description) store.registry.describe(id, description);
	if ((await server.repo(id)) === null)
		throw new Error(`The shared repository '${name}' is registered but missing from storage.`);
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
