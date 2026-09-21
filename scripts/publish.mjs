#!/usr/bin/env node
import { resolve } from 'node:path';
/**
 * Packs and publishes every public package to one registry.
 *
 * Packing and publishing are separate steps. The script packs once and
 * publishes those exact tarballs, so the bytes that land on the registry are
 * the bytes it packed.
 *
 * A channel picks the registry. The dev channel publishes to GitHub Packages
 * and the release channel publishes to npmjs. `--registry` overrides the
 * channel. Official releases go through `scripts/release.mjs`, which adds the
 * guards, the consumer check, and the promotion to `latest`.
 *
 * Idempotent by design: a version already on the registry is skipped, so a
 * rerun after a partial failure finishes the release.
 *
 *   node scripts/publish.mjs --channel dev            # pack, then publish
 *   node scripts/publish.mjs --channel dev --pack-only
 *   node scripts/publish.mjs --skip-pack --dry-run
 *   node scripts/publish.mjs --channel release --yes  # publishes to npmjs
 *   node scripts/publish.mjs --tag next
 *
 * The token comes from NODE_AUTH_TOKEN in the environment and never from an
 * argument.
 */
import { pathToFileURL } from 'node:url';
import { dependencyOrder, publishablePackages, ROOT, sharedVersion } from './packages.mjs';
import {
	channelRegistry,
	DEFAULT_TAGS,
	exec,
	packAll,
	publishAll,
	readFlag,
	withTokenConfig,
} from './release-lib.mjs';

const OUT_DIR = 'dist-release';

/** Read the options of one run. Throws on a channel that does not exist. */
export function parseOptions(argv) {
	const channel = readFlag(argv, '--channel') ?? 'dev';
	const registry = readFlag(argv, '--registry') ?? channelRegistry(channel);
	const tag = readFlag(argv, '--tag') ?? DEFAULT_TAGS[channel];
	// A dev build never takes the tag that consumers install by default.
	if (channel === 'dev' && tag === 'latest') {
		throw new Error('The dev channel cannot publish under latest. Use scripts/release.mjs.');
	}
	return {
		channel,
		registry,
		tag,
		otp: readFlag(argv, '--otp'),
		dryRun: argv.includes('--dry-run'),
		yes: argv.includes('--yes'),
		packOnly: argv.includes('--pack-only'),
		skipPack: argv.includes('--skip-pack'),
		outDir: resolve(ROOT, OUT_DIR),
	};
}

/** Refuse before any work when the run would publish without permission. */
function requirePermission(options) {
	if (options.channel === 'release' && !options.dryRun && !options.yes) {
		throw new Error(`Publishing to ${options.registry} needs --yes.`);
	}
	if (!options.dryRun && !process.env.NODE_AUTH_TOKEN) {
		throw new Error('Set NODE_AUTH_TOKEN in the environment before publishing.');
	}
}

async function main(argv) {
	const options = parseOptions(argv);
	const packages = dependencyOrder(await publishablePackages());
	if (packages.length === 0) throw new Error('No publishable packages found.');
	// Throws, naming the offenders, if the packages have drifted apart.
	sharedVersion(packages);

	if (!options.packOnly) requirePermission(options);
	if (!options.skipPack) await packAll(exec, packages, options.outDir);
	if (options.packOnly) {
		console.log(`${packages.length} tarball(s) in ${options.outDir}.`);
		return;
	}
	const counts = await withTokenConfig(options.registry, process.env, (userconfig) =>
		publishAll(exec, packages, { ...options, userconfig }),
	);
	console.log(`${counts.published} package(s) published, ${counts.skipped} skipped.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
