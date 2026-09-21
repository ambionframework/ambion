import { access, cp, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const TEMPLATES = ['node', 'cloudflare'] as const;
export type Template = (typeof TEMPLATES)[number];
export const DEFAULT_TEMPLATE: Template = 'node';

const DEPENDENCIES: Record<Template, readonly string[]> = {
	node: [
		'@ambionframework/ambion',
		'@ambionframework/journal',
		'@ambionframework/pi',
		'@ambionframework/cli',
	],
	cloudflare: [
		'@ambionframework/ambion',
		'@ambionframework/cloudflare',
		'@ambionframework/pi',
		'@ambionframework/cli',
	],
};

export class ProjectError extends Error {}

/** Narrow a `--template` value. An unknown name is a `ProjectError`. */
export function parseTemplate(value: string): Template {
	const template = TEMPLATES.find((name) => name === value);
	if (template === undefined)
		throw new ProjectError(`Unknown template '${value}'. Use ${TEMPLATES.join(' or ')}.`);
	return template;
}

function templateCandidates(template: Template): string[] {
	return [
		fileURLToPath(new URL(`../templates/${template}/`, import.meta.url)),
		fileURLToPath(new URL(`../../templates/${template}/`, import.meta.url)),
	];
}

async function templateDirectory(template: Template): Promise<string> {
	for (const candidate of templateCandidates(template)) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// The first path is for the bundled file. The second is for source tests.
		}
	}
	throw new ProjectError(`The Ambion ${template} template is missing from this installation.`);
}

function projectName(directory: string): string {
	const name = basename(directory);
	if (!PROJECT_NAME.test(name)) {
		throw new ProjectError(
			`Project name '${name}' is invalid. Use 1 to 63 lowercase letters, numbers, or dashes.`,
		);
	}
	return name;
}

async function ensureTargetIsEmpty(target: string): Promise<void> {
	try {
		const entries = await readdir(target);
		if (entries.length > 0) {
			throw new ProjectError(`Refusing to overwrite '${target}'. Choose an empty directory.`);
		}
	} catch (error) {
		if (error instanceof ProjectError) throw error;
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		await mkdir(dirname(target), { recursive: true });
	}
}

async function rewritePackage(
	target: string,
	name: string,
	version: string,
	template: Template,
): Promise<void> {
	const path = resolve(target, 'package.json');
	const packageJson = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	packageJson.name = name;
	for (const section of ['dependencies', 'devDependencies']) {
		const dependencies = packageJson[section];
		if (typeof dependencies !== 'object' || dependencies === null) continue;
		for (const dependency of DEPENDENCIES[template]) {
			if (Object.hasOwn(dependencies, dependency)) {
				(dependencies as Record<string, unknown>)[dependency] = version;
			}
		}
	}
	await writeFile(path, `${JSON.stringify(packageJson, null, '\t')}\n`);
}

async function rewriteWrangler(target: string, name: string): Promise<void> {
	const path = resolve(target, 'wrangler.jsonc');
	const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
	config.name = name;
	await writeFile(path, `${JSON.stringify(config, null, '\t')}\n`);
}

async function restoreDotfiles(target: string): Promise<void> {
	for (const [sourceName, targetName] of [
		['gitignore', '.gitignore'],
		['npmrc', '.npmrc'],
	] as const) {
		const source = resolve(target, sourceName);
		try {
			await writeFile(resolve(target, targetName), await readFile(source));
			await unlink(source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

/** Create a project from a packaged template. The default template runs in Node. */
export async function createProject(
	directory: string,
	version: string,
	template: Template = DEFAULT_TEMPLATE,
): Promise<string> {
	if (directory.trim() === '') throw new ProjectError('A project directory is required.');
	const source = await templateDirectory(parseTemplate(template));
	const target = resolve(directory);
	const name = projectName(target);
	await ensureTargetIsEmpty(target);
	for (const entry of await readdir(source)) {
		await cp(resolve(source, entry), resolve(target, entry), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
	}
	await restoreDotfiles(target);
	await rewritePackage(target, name, version, template);
	if (template === 'cloudflare') await rewriteWrangler(target, name);
	return target;
}
