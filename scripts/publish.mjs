#!/usr/bin/env node
/**
 * Packs and publishes every public package to GitHub Packages.
 *
 * Packing and publishing are separate steps on purpose. CI packs first, signs
 * the resulting tarballs with a build-provenance attestation, then publishes
 * those exact files — so what is attested and what lands on the registry are
 * the same bytes, not two independent runs of `npm pack`.
 *
 * Idempotent by design: a version already on the registry is skipped rather
 * than failing the run, so re-running a partially failed release finishes it
 * instead of starting over.
 *
 *   node scripts/publish.mjs                          # pack, then publish
 *   node scripts/publish.mjs --pack-only              # stop after packing
 *   node scripts/publish.mjs --skip-pack              # publish what is on disk
 *   node scripts/publish.mjs --dry-run
 *   node scripts/publish.mjs --tag next
 */
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publishablePackages, ROOT, sharedVersion } from './packages.mjs';

const OUT_DIR = 'dist-release';

function run(command, args, options = {}) {
	return spawnSync(command, args, { encoding: 'utf8', ...options });
}

/** The filename `npm pack` gives a package, derived rather than globbed. */
export function tarballName(name, version) {
	return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

/**
 * The registry the packages themselves declare. `publishConfig.registry` is
 * where npm reads it from, so keeping a second copy in this script would just
 * be somewhere for the two to disagree.
 */
function resolveRegistry(packages) {
	const declared = new Set(packages.map((entry) => entry.manifest.publishConfig?.registry));
	if (declared.size !== 1 || declared.has(undefined)) {
		const shown = [...declared].map((value) => value ?? '(none)').join(', ');
		throw new Error(`Every package needs the same publishConfig.registry; found: ${shown}.`);
	}
	return [...declared][0];
}

/** True when this exact name@version is already on the registry. */
function alreadyPublished(registry, name, version) {
	const result = run('npm', ['view', `${name}@${version}`, 'version', '--registry', registry]);
	return result.status === 0 && result.stdout.trim() === version;
}

/**
 * Pack every package into `outDir`. Returns false once a pack has failed, and
 * the exit code is already set by then — the caller only has to stop.
 */
async function pack(packages, outDir) {
	// A stale tarball from an earlier version must never be published by a
	// later run, so the directory starts empty every time.
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });
	for (const entry of packages) {
		const result = run('pnpm', ['pack', '--pack-destination', outDir], {
			cwd: entry.dir,
			stdio: 'inherit',
		});
		if (result.status !== 0) {
			fail(`Failed to pack ${entry.manifest.name}.`, result.status);
			return false;
		}
		console.log(`packed  ${tarballName(entry.manifest.name, entry.manifest.version)}`);
	}
	return true;
}

/**
 * Publish one packed tarball. 'skipped' is the idempotent path — this exact
 * name@version is already on the registry — and 'failed' has set the exit code.
 */
function publishOne(entry, { registry, outDir, tag, dryRun }) {
	const { name, version } = entry.manifest;
	if (alreadyPublished(registry, name, version)) {
		console.log(`skip    ${name}@${version} (already on ${registry})`);
		return 'skipped';
	}
	const tarball = resolve(outDir, tarballName(name, version));
	const args = ['publish', tarball, '--registry', registry, '--tag', tag];
	if (dryRun) args.push('--dry-run');
	console.log(`publish ${name}@${version}${dryRun ? ' (dry run)' : ''}`);
	const result = run('npm', args, { cwd: ROOT, stdio: 'inherit' });
	if (result.status !== 0) {
		fail(`Failed to publish ${name}@${version}.`, result.status);
		return 'failed';
	}
	return 'published';
}

async function main(argv) {
	const options = {
		dryRun: argv.includes('--dry-run'),
		tag: readFlag(argv, '--tag') ?? 'latest',
		outDir: resolve(ROOT, OUT_DIR),
	};
	const packages = await publishablePackages();

	if (packages.length === 0) {
		fail('No publishable packages found.');
		return;
	}
	options.registry = resolveRegistry(packages);
	// Throws, naming the offenders, if the packages have drifted apart.
	sharedVersion(packages);

	if (!argv.includes('--skip-pack') && !(await pack(packages, options.outDir))) return;

	if (argv.includes('--pack-only')) {
		console.log(`${packages.length} tarball(s) in ${options.outDir}.`);
		return;
	}

	if (!options.dryRun && !process.env.NODE_AUTH_TOKEN && !process.env.NPM_TOKEN) {
		fail('Set NODE_AUTH_TOKEN (a token with `write:packages`) before publishing.');
		return;
	}

	const published = publishAll(packages, options);
	if (published === undefined) return;
	console.log(`${published} package(s) published, ${packages.length - published} skipped.`);
}

/**
 * Publish every packed tarball, returning how many were actually pushed — or
 * undefined once one has failed, the exit code already set by then.
 */
function publishAll(packages, options) {
	let published = 0;
	for (const entry of packages) {
		const outcome = publishOne(entry, options);
		if (outcome === 'failed') return undefined;
		if (outcome === 'published') published += 1;
	}
	return published;
}

function fail(message, code = 1) {
	console.error(message);
	process.exitCode = code;
}

function readFlag(argv, flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

main(process.argv.slice(2)).catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
