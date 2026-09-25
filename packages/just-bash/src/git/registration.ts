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

import {
	changeTo,
	filesOf,
	hashesOf,
	SOURCES,
	sameFiles,
	TEMPLATES,
	type TemplateFiles,
	type TemplateRegistration,
	validName,
} from '@ambionframework/workspace/git';
import { flattenTree, type GitRepo, readCommit, readHead } from 'just-git/repo';
import type { GitServer } from 'just-git/server';
import type { OpenGitStorage, RegistryRow } from './storage.ts';
import type { TokenClaims } from './tokens.ts';

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
export async function settleAll(store: OpenGitStorage): Promise<void> {
	for (const row of store.registry.all()) {
		if (row.state === 'forking') await settledRow(store, row.id);
	}
}

/** Register every template, in name order. */
export async function registerTemplates(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	templates: Readonly<Record<string, TemplateRegistration>>,
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
	registration: TemplateRegistration,
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

/** Make the tip of `template-sources/<name>` hold `files`, and give the repository and its tip. */
async function commitSource(
	store: OpenGitStorage,
	server: GitServer<TokenClaims>,
	name: string,
	files: TemplateFiles,
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
