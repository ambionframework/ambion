#!/usr/bin/env node
/**
 * Sets every publishable package to one version.
 *
 * Ambion releases in lockstep: the CLI and the runtime are cut from the same
 * commit and expected to match, so there is one version number and no
 * per-package changelog to reconcile.
 *
 *   node scripts/version.mjs 0.1.0
 *   node scripts/version.mjs --check     # verify they already agree
 */
import { readFile, writeFile } from 'node:fs/promises';
import { publishablePackages, sharedVersion } from './packages.mjs';

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function main(argv) {
	const packages = await publishablePackages();
	if (packages.length === 0) {
		console.error('No publishable packages found.');
		process.exitCode = 1;
		return;
	}

	for (const entry of packages) {
		console.log(`${entry.manifest.name}@${entry.manifest.version}`);
	}

	if (argv[0] === '--check') {
		// Throws with the disagreeing versions named, which is the whole check.
		sharedVersion(packages);
		return;
	}

	const version = argv[0];
	if (!version || !SEMVER.test(version)) {
		console.error('Usage: node scripts/version.mjs <x.y.z[-tag]> | --check');
		process.exitCode = 1;
		return;
	}

	for (const entry of packages) {
		// Rewrite only the version line so formatting, key order and trailing
		// newline survive: this file is read by humans in review.
		const source = await readFile(entry.manifestPath, 'utf8');
		const next = source.replace(/(\n\t"version":\s*")[^"]*(")/, `$1${version}$2`);
		if (next === source) {
			throw new Error(`Could not find a version field in ${entry.manifestPath}.`);
		}
		await writeFile(entry.manifestPath, next, 'utf8');
		console.log(`  -> ${entry.manifest.name}@${version}`);
	}
}

main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
