/**
 * The steps that `publish.mjs` and `release.mjs` share: packing once, the
 * registry of a channel, the token configuration, and the idempotent publish.
 *
 * This module has no side effects on import. Every function that starts a
 * process takes a `run` function with the shape of `spawnSync`, sync or async, so a
 * test can record each call and answer it without a network.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** The registry that each release channel publishes to. */
const REGISTRIES = {
	dev: 'https://npm.pkg.github.com',
	release: 'https://registry.npmjs.org',
};

/** The dist-tag that each channel publishes under when the caller gives none. */
export const DEFAULT_TAGS = { dev: 'dev', release: 'next' };

/** Start a process and wait for it. The default `run` of every function here. */
export function exec(command, args, options = {}) {
	return spawnSync(command, args, { encoding: 'utf8', ...options });
}

/** The registry of a channel. Throws on a channel that does not exist. */
export function channelRegistry(channel) {
	const registry = REGISTRIES[channel];
	if (registry === undefined) {
		throw new Error(`Unknown channel "${channel}". Use dev or release.`);
	}
	return registry;
}

/** The filename `npm pack` gives a package. The script derives it from the name and version. */
export function tarballName(name, version) {
	return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

/**
 * Run `fn` with the path of a temporary npm user config that reads the token
 * from NODE_AUTH_TOKEN. The file holds the text `${NODE_AUTH_TOKEN}` and never
 * the token: npm expands it from the environment of the child process. The
 * file is deleted when `fn` ends. Without a token the function gets undefined.
 */
export async function withTokenConfig(registry, env, fn) {
	if (!env.NODE_AUTH_TOKEN) return fn(undefined);
	const dir = await mkdtemp(join(tmpdir(), 'ambion-npmrc-'));
	const file = join(dir, 'npmrc');
	try {
		const host = new URL(registry).host;
		await writeFile(file, `//${host}/:_authToken=\${NODE_AUTH_TOKEN}\n`, { mode: 0o600 });
		return await fn(file);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** True when this exact name@version is already on the registry. */
export async function alreadyPublished(run, registry, name, version, { userconfig, env } = {}) {
	const args = ['view', `${name}@${version}`, 'version', '--registry', registry];
	// GitHub Packages needs a token for every read, so the check carries the same config.
	if (userconfig) args.push('--userconfig', userconfig);
	const result = await run('npm', args, env ? { env } : {});
	return result.status === 0 && result.stdout.trim() === version;
}

/**
 * Pack every package into `outDir`, one `pnpm pack` per package. Throws once a
 * pack fails. The directory starts empty, so a stale tarball from an earlier
 * version never reaches a registry.
 */
export async function packAll(run, packages, outDir, log = console.log) {
	await rm(outDir, { recursive: true, force: true });
	await mkdir(outDir, { recursive: true });
	for (const entry of packages) {
		const { name, version } = entry.manifest;
		const result = await run('pnpm', ['pack', '--pack-destination', outDir], {
			cwd: entry.dir,
			stdio: 'inherit',
		});
		if (result.status !== 0) throw new Error(`Failed to pack ${name}.`);
		log(`packed  ${tarballName(name, version)}`);
	}
}

/**
 * Publish one packed tarball. Returns 'skipped' when this exact name@version
 * is on the registry already, and 'published' otherwise. Throws on a failure.
 * A dry run adds `--dry-run` to `npm publish`, so it never reaches the endpoint.
 */
async function publishOne(run, entry, options) {
	const { registry, outDir, tag, dryRun, userconfig, otp, env, log = console.log } = options;
	const { name, version } = entry.manifest;
	if (await alreadyPublished(run, registry, name, version, { userconfig, env })) {
		log(`skip    ${name}@${version} (already on ${registry})`);
		return 'skipped';
	}
	const tarball = resolve(outDir, tarballName(name, version));
	const args = ['publish', tarball, '--registry', registry, '--tag', tag, '--access', 'public'];
	if (userconfig) args.push('--userconfig', userconfig);
	if (otp) args.push('--otp', otp);
	if (dryRun) args.push('--dry-run');
	log(`publish ${name}@${version}${dryRun ? ' (dry run)' : ''}`);
	const result = await run('npm', args, { stdio: 'inherit', env });
	if (result.status !== 0) throw new Error(`Failed to publish ${name}@${version}.`);
	return 'published';
}

/** Publish every tarball in the order given. Returns the counts. */
export async function publishAll(run, packages, options) {
	let published = 0;
	for (const entry of packages) {
		if ((await publishOne(run, entry, options)) === 'published') published += 1;
	}
	return { published, skipped: packages.length - published };
}

/** The value of `--flag value`, or undefined. */
export function readFlag(argv, flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}
