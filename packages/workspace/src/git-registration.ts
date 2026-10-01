/**
 * Repository registration: the decisions that every git backend shares.
 *
 * A backend supplies the storage steps of `RegistrationSteps`.
 * `registerRepositories` holds every decision: which repositories it
 * registers and in which order, which names and paths it refuses, which
 * case a repository takes, and what it verifies after a write. It loads no
 * git library.
 */

import { validName } from './git-names.ts';
import { filesOf, type RepositoryRegistration } from './git-templates.ts';
import { hashesOf, type SourceFiles, sameFiles } from './sources.ts';

/** The storage steps of one git backend. `registerRepositories` holds every decision. */
export interface RegistrationSteps {
	/**
	 * The blob hashes at the tip of the published template, by path, or
	 * `undefined` when no template is published. Writes the description when
	 * it differs.
	 */
	template(
		name: string,
		description: string | undefined,
	): Promise<ReadonlyMap<string, string> | undefined>;
	/** Create a template that holds `files`, and publish it. */
	createTemplate(name: string, files: SourceFiles, description: string | undefined): Promise<void>;
	/**
	 * Commit `files` on the tip of the published template, and move `main`.
	 * Throws with the cause when the backend refuses the move.
	 */
	updateTemplate(name: string, files: SourceFiles, description: string | undefined): Promise<void>;
	/**
	 * Whether the shared repository is published. Writes the description
	 * when it differs, and reads no source.
	 */
	shared(name: string, description: string | undefined): Promise<boolean>;
	/** Seed the shared repository once with `files`, and publish it. */
	seedShared(name: string, files: SourceFiles, description: string | undefined): Promise<void>;
}

/** The two kinds of repository that a host registers. The text names the kind in a message. */
type Kind = 'template' | 'shared repository';

/** The registrations of a host, by name. */
type Registrations = Readonly<Record<string, RepositoryRegistration>>;

function checkName(kind: Kind, name: string): void {
	if (!validName(name)) throw new Error(`'${name}' is not a valid ${kind} name.`);
}

/** Refuse a path that leaves the root of the repository: an empty part, `.`, `..`, or `.git`. */
function checkPaths(kind: Kind, name: string, files: SourceFiles): void {
	for (const path of Object.keys(files)) {
		const parts = path.split('/');
		if (parts.some((part) => part === '' || part === '.' || part === '..' || part === '.git')) {
			throw new Error(`The ${kind} '${name}' holds the path '${path}', which leaves its root.`);
		}
	}
}

/** Read the source of a registration, and refuse a path that leaves the root of the repository. */
async function sourceOf(
	kind: Kind,
	name: string,
	registration: RepositoryRegistration,
): Promise<SourceFiles> {
	const files = await filesOf(registration);
	checkPaths(kind, name, files);
	return files;
}

/**
 * Update the template. A backend that refuses the move throws with its
 * cause. When the tip already holds the source, another host process
 * landed the same files, and the registration succeeds.
 */
async function updateTemplate(
	steps: RegistrationSteps,
	name: string,
	files: SourceFiles,
	description: string | undefined,
	wanted: ReadonlyMap<string, string>,
): Promise<void> {
	try {
		await steps.updateTemplate(name, files, description);
	} catch (error) {
		const landed = await steps.template(name, description);
		if (landed === undefined || !sameFiles(landed, wanted)) throw error;
	}
}

async function verifyTemplate(
	steps: RegistrationSteps,
	name: string,
	description: string | undefined,
	wanted: ReadonlyMap<string, string>,
): Promise<void> {
	const landed = await steps.template(name, description);
	if (landed === undefined)
		throw new Error(`The template '${name}' is missing after its registration.`);
	if (!sameFiles(landed, wanted)) {
		throw new Error(`The template '${name}' does not hold its source after its registration.`);
	}
}

async function registerTemplate(
	steps: RegistrationSteps,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	checkName('template', name);
	const { description } = registration;
	const files = await sourceOf('template', name, registration);
	const wanted = hashesOf(files);
	const tip = await steps.template(name, description);
	if (tip !== undefined && sameFiles(tip, wanted)) return;
	if (tip === undefined) await steps.createTemplate(name, files, description);
	else await updateTemplate(steps, name, files, description, wanted);
	await verifyTemplate(steps, name, description, wanted);
}

async function registerShared(
	steps: RegistrationSteps,
	name: string,
	registration: RepositoryRegistration,
): Promise<void> {
	checkName('shared repository', name);
	const { description } = registration;
	// A published shared repository is durable shared state. Registration
	// only writes its description and reads no source.
	if (await steps.shared(name, description)) return;
	await steps.seedShared(
		name,
		await sourceOf('shared repository', name, registration),
		description,
	);
	if (!(await steps.shared(name, description)))
		throw new Error(`The shared repository '${name}' is missing after its registration.`);
}

async function inNameOrder(
	registrations: Registrations | undefined,
	register: (name: string, registration: RepositoryRegistration) => Promise<void>,
): Promise<void> {
	const all = registrations ?? {};
	for (const name of Object.keys(all).sort()) {
		const registration = all[name];
		if (registration !== undefined) await register(name, registration);
	}
}

/**
 * Register every template, then every shared repository, each in name
 * order. A template that exists and holds its source stays as it is. A
 * template that differs takes a commit of the source. A missing template
 * is created. A shared repository that is published changes only its
 * description. A missing one is seeded once. Each write ends with a read
 * that proves the repository landed.
 */
export async function registerRepositories(
	steps: RegistrationSteps,
	repositories: { readonly templates?: Registrations; readonly shared?: Registrations },
): Promise<void> {
	await inNameOrder(repositories.templates, (name, registration) =>
		registerTemplate(steps, name, registration),
	);
	await inNameOrder(repositories.shared, (name, registration) =>
		registerShared(steps, name, registration),
	);
}
