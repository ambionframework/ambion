/**
 * Shared knowledge about this repository's publishable packages.
 *
 * This module has no side effects on import — it is the reason `version.mjs`
 * and `publish.mjs` can both use it while each staying a plain CLI. A module
 * that is both a library and a command runs its command when someone imports
 * it, which is how the caller's argv ends up parsed as the importee's flags.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace directories searched for packages, in listing order. */
const GROUPS = ['packages', 'examples'];

/** Every workspace package that is not marked private, sorted by name. */
export async function publishablePackages() {
	const found = [];
	for (const group of GROUPS) {
		for (const dir of await groupDirs(group)) {
			const entry = await readPackage(dir);
			if (entry) found.push(entry);
		}
	}
	return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

/** The package directories of one workspace group; a group that is absent has none. */
async function groupDirs(group) {
	const root = join(ROOT, group);
	try {
		const entries = await readdir(root, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
	} catch {
		return [];
	}
}

/** A directory's manifest, or undefined when it has none or declares itself private. */
async function readPackage(dir) {
	const manifestPath = join(dir, 'package.json');
	try {
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
		return manifest.private === true ? undefined : { dir, manifestPath, manifest };
	} catch {
		return undefined;
	}
}

/** The one version every publishable package must share. */
export function sharedVersion(packages) {
	const versions = new Set(packages.map((entry) => entry.manifest.version));
	if (versions.size !== 1) {
		throw new Error(
			`Package versions disagree (${[...versions].join(', ')}). ` +
				'Run `pnpm run version:set <x.y.z>` first.',
		);
	}
	return [...versions][0];
}

/**
 * The packages in dependency order: a package follows every workspace package
 * it depends on. Ties keep the sorted name order, so the result is stable.
 */
export function dependencyOrder(packages) {
	const byName = new Map(packages.map((entry) => [entry.manifest.name, entry]));
	const ordered = [];
	const seen = new Set();
	const visit = (entry) => {
		if (seen.has(entry.manifest.name)) return;
		seen.add(entry.manifest.name);
		for (const dependency of workspaceDependencies(entry.manifest)) {
			const target = byName.get(dependency);
			if (target) visit(target);
		}
		ordered.push(entry);
	};
	for (const entry of packages) visit(entry);
	return ordered;
}

/** The names a manifest depends on at install time, in every dependency field. */
function workspaceDependencies(manifest) {
	const fields = ['dependencies', 'peerDependencies', 'optionalDependencies'];
	return fields.flatMap((field) => Object.keys(manifest[field] ?? {})).sort();
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

/**
 * True for a release, a prerelease, or a stamped dev version such as
 * 0.2.0-dev.42.g1a2b3c4. A numeric identifier with a leading zero is invalid.
 */
export function isVersion(version) {
	if (!VERSION.test(version)) return false;
	const identifiers = (version.split('-')[1] ?? '').split('.').filter(Boolean);
	return identifiers.every((part) => !/^0\d+$/.test(part));
}
