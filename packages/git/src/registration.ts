/**
 * Template registration: idempotent, and it resumes after a crash.
 *
 * It runs once, before the first operation of the backend. For each
 * template it takes the first case that holds.
 *
 * 1. The template exists, and its tree equals the source. Nothing happens.
 * 2. The template exists, and its tree differs. Registration fails with an
 *    error that names the template.
 * 3. The template does not exist. `template-sources/<name>` gets the source
 *    at its tip, and the backend forks it to `templates/<name>`.
 *
 * A crash between the steps of case 3 leaves a state that case 3 finishes
 * at the next registration.
 */

import type { GitServer } from 'just-git/server';
import { SOURCES, TEMPLATES, validName } from './names.ts';
import type { OpenGitStorage, RegistryRow } from './storage.ts';
import {
	changeTo,
	filesOf,
	hashesOf,
	sameFiles,
	type TemplateRegistration,
	tipHashes,
} from './templates.ts';
import type { TokenClaims } from './tokens.ts';

/** The author of every commit that the backend writes. */
const BACKEND_AUTHOR = { name: 'ambion', email: 'ambion@ambion.invalid' };

/** The default branch of every repository that the backend creates. */
export const DEFAULT_BRANCH = 'main';

/**
 * The row of `id` after a crash is settled: a `forking` row whose
 * repository exists becomes `ready`, and one whose repository does not
 * exist goes.
 */
export async function settledRow(
	store: OpenGitStorage,
	id: string,
): Promise<RegistryRow | undefined> {
	const row = store.registry.get(id);
	if (row === undefined || row.state === 'ready') return row;
	if (await store.storage.hasRepo(id)) {
		store.registry.ready(id);
		return { ...row, state: 'ready' };
	}
	store.registry.remove(id);
	return undefined;
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
	const existing = row === undefined ? null : await server.repo(template);
	if (existing !== null) {
		if (sameFiles(await tipHashes(existing), wanted)) return;
		throw new Error(
			`The template '${name}' changed since its registration. A template never changes: register the change under a new name, such as '${name}-2'.`,
		);
	}
	const source = `${SOURCES}/${name}`;
	if (!(await store.storage.hasRepo(source))) {
		await server.createRepo(source, { defaultBranch: DEFAULT_BRANCH });
	}
	const tip = await tipHashes(await server.requireRepo(source));
	if (!sameFiles(tip, wanted)) {
		await server.commit(source, {
			files: changeTo(files, tip),
			message: `Register the template ${name}\n`,
			author: BACKEND_AUTHOR,
			branch: DEFAULT_BRANCH,
		});
	}
	if (row === undefined) store.registry.begin(template, undefined, registration.description);
	await server.forkRepo(source, template);
	store.registry.ready(template);
}
