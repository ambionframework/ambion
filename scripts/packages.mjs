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
		let entries;
		try {
			entries = await readdir(join(ROOT, group), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = join(ROOT, group, entry.name);
			const manifestPath = join(dir, 'package.json');
			let manifest;
			try {
				manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
			} catch {
				continue;
			}
			if (manifest.private === true) continue;
			found.push({ dir, manifestPath, manifest });
		}
	}
	return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
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
