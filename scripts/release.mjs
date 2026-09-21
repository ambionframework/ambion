#!/usr/bin/env node
/**
 * The official release, run by the owner on a local machine.
 *
 *   node scripts/release.mjs stage --dry-run   # guards, gate, pack, npm dry run
 *   node scripts/release.mjs stage             # publish to npmjs under next
 *   node scripts/release.mjs verify            # install from npmjs, no token
 *   node scripts/release.mjs promote           # move latest to the version
 *   node scripts/release.mjs status            # print the dist-tags
 *
 * Every step is idempotent. A rerun after a partial failure finishes the rest.
 * CI never publishes to npmjs. The token comes from NODE_AUTH_TOKEN in the
 * environment. The script writes it to no file and passes it in no argument:
 * npm reads it through a temporary user config that holds the text
 * `${NODE_AUTH_TOKEN}`, and the script deletes that file after the command.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { dependencyOrder, publishablePackages, ROOT, sharedVersion } from './packages.mjs';
import {
	alreadyPublished,
	channelRegistry,
	exec,
	packAll,
	publishAll,
	readFlag,
	withTokenConfig,
} from './release-lib.mjs';

const STAGE_TAG = 'next';
const PROMOTE_TAG = 'latest';

/** Ask on the terminal. Without a terminal the answer is no. */
async function askInteractive(question) {
	if (!process.stdin.isTTY) return false;
	const reader = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await reader.question(`${question}\nType yes to continue: `)).trim() === 'yes';
	} finally {
		reader.close();
	}
}

/**
 * The registry of a release command. `--registry` is for a test against a
 * local registry. A remote host would receive the npm token, so the script
 * refuses one.
 */
function registryOf(argv) {
	const given = readFlag(argv, '--registry');
	if (given === undefined) return channelRegistry('release');
	const { hostname } = new URL(given);
	if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) {
		throw new Error('--registry accepts a local registry only.');
	}
	return given;
}

/** The shared state of one command. Tests replace `run`, `confirm`, and `log`. */
export async function defaultContext(argv = []) {
	return {
		packages: dependencyOrder(await publishablePackages()),
		run: exec,
		env: process.env,
		log: console.log,
		confirm: askInteractive,
		root: ROOT,
		outDir: join(ROOT, 'dist-release'),
		registry: registryOf(argv),
	};
}

function list(packages, version) {
	return packages.map((entry) => `  ${entry.manifest.name}@${version}`).join('\n');
}

async function gitOutput(ctx, args) {
	const result = await ctx.run('git', args, { cwd: ctx.root });
	if (result.status !== 0) throw new Error(`git ${args[0]} failed.`);
	return result.stdout.trim();
}

async function publishedCount(ctx, version) {
	let count = 0;
	for (const entry of ctx.packages) {
		if (await alreadyPublished(ctx.run, ctx.registry, entry.manifest.name, version)) count += 1;
	}
	return count;
}

/** The checks that stage runs before it spends time or reaches a registry. */
async function stageGuards(ctx) {
	if ((await gitOutput(ctx, ['status', '--porcelain'])) !== '') {
		throw new Error('The working tree is not clean. Commit or stash first.');
	}
	// Throws, naming the offenders, when the versions disagree.
	const version = sharedVersion(ctx.packages);
	const tag = `v${version}`;
	const tagged = await ctx.run('git', ['rev-list', '-n', '1', tag], { cwd: ctx.root });
	if (tagged.status !== 0) throw new Error(`The tag ${tag} does not exist.`);
	if (tagged.stdout.trim() !== (await gitOutput(ctx, ['rev-parse', 'HEAD']))) {
		throw new Error(`HEAD is not the commit of the tag ${tag}.`);
	}
	if ((await publishedCount(ctx, version)) === ctx.packages.length) {
		throw new Error(`Every package is on ${ctx.registry} at ${version} already. Run verify.`);
	}
	return version;
}

async function requireApproval(ctx, options, question) {
	if (options.dryRun || options.yes) return;
	if (!(await ctx.confirm(question))) throw new Error('Not confirmed. Nothing changed.');
}

function requireToken(ctx, options) {
	if (!options.dryRun && !ctx.env.NODE_AUTH_TOKEN) {
		throw new Error('Set NODE_AUTH_TOKEN in the environment. A dry run needs no token.');
	}
}

/**
 * Guard, run the gate, pack once, and publish those tarballs under `next`.
 * A dry run stops each `npm publish` before the endpoint.
 */
export async function stage(ctx, options = {}) {
	requireToken(ctx, options);
	const version = await stageGuards(ctx);
	await requireApproval(
		ctx,
		options,
		`Publish to ${ctx.registry} under ${STAGE_TAG}:\n${list(ctx.packages, version)}`,
	);
	if (options.skipGate) {
		ctx.log('Skipping the local gate. Confirm that CI is green for this commit.');
	} else {
		const gate = await ctx.run('pnpm', ['run', 'check'], { cwd: ctx.root, stdio: 'inherit' });
		if (gate.status !== 0) throw new Error('The gate failed. Nothing was published.');
	}
	await packAll(ctx.run, ctx.packages, ctx.outDir, ctx.log);
	const counts = await withTokenConfig(ctx.registry, ctx.env, (userconfig) =>
		publishAll(ctx.run, ctx.packages, {
			registry: ctx.registry,
			outDir: ctx.outDir,
			tag: STAGE_TAG,
			dryRun: options.dryRun === true,
			otp: options.otp,
			env: ctx.env,
			userconfig,
			log: ctx.log,
		}),
	);
	ctx.log(`${counts.published} package(s) published, ${counts.skipped} skipped.`);
	if (!options.dryRun) ctx.log(`Next: node scripts/release.mjs verify`);
}

/** The environment of a consumer that has no token and no npm configuration. */
function cleanEnvironment(base, home, registry) {
	const kept = Object.entries(base).filter(
		([key]) => !/^(npm_config_|NPM_CONFIG_|NODE_AUTH_TOKEN|NPM_TOKEN|GITHUB_TOKEN)/.test(key),
	);
	// npm refuses one file as both the user and the global config.
	const userConfig = join(home, 'empty-user-npmrc');
	const globalConfig = join(home, 'empty-global-npmrc');
	return {
		...Object.fromEntries(kept),
		HOME: home,
		XDG_CONFIG_HOME: join(home, '.config'),
		NPM_CONFIG_USERCONFIG: userConfig,
		NPM_CONFIG_GLOBALCONFIG: globalConfig,
		NPM_CONFIG_REGISTRY: registry,
	};
}

async function step(ctx, label, command, args, options) {
	ctx.log(`verify  ${label}`);
	const result = await ctx.run(command, args, { stdio: 'inherit', ...options });
	if (result.status !== 0) throw new Error(`Verify failed at: ${label}.`);
}

const RESOURCE_CHECK =
	"import('@ambionframework/workspace/resource').then((m) => {" +
	"if (typeof m.openResource !== 'function') process.exit(1); });";

/**
 * Install the staged version from the registry in a directory outside the
 * repository, with no token and a clean npm configuration.
 */
export async function verify(ctx, options = {}) {
	const version = options.version ?? sharedVersion(ctx.packages);
	for (const entry of ctx.packages) {
		const { name } = entry.manifest;
		if (!(await alreadyPublished(ctx.run, ctx.registry, name, version))) {
			throw new Error(`${name}@${version} is not on ${ctx.registry}. Run stage first.`);
		}
	}
	const home = await mkdtemp(join(tmpdir(), 'ambion-verify-'));
	try {
		await writeFile(join(home, 'empty-user-npmrc'), '');
		await writeFile(join(home, 'empty-global-npmrc'), '');
		const env = cleanEnvironment(ctx.env, home, ctx.registry);
		const consumer = join(home, 'consumer');
		const resource = join(home, 'resource');
		await mkdir(consumer, { recursive: true });
		await mkdir(resource, { recursive: true });
		const cli = `@ambionframework/cli@${version}`;
		await step(
			ctx,
			'ambion new',
			'npm',
			['exec', '--yes', `--package=${cli}`, '--', 'ambion', 'new', 'team'],
			{ cwd: consumer, env },
		);
		const team = join(consumer, 'team');
		await step(ctx, 'install the project', 'pnpm', ['install', '--ignore-scripts'], {
			cwd: team,
			env,
		});
		await step(ctx, 'typecheck the project', 'pnpm', ['run', 'check:types'], { cwd: team, env });
		await writeFile(join(resource, 'package.json'), '{"private":true,"type":"module"}\n');
		await step(
			ctx,
			'install the workspace package',
			'npm',
			['install', `@ambionframework/workspace@${version}`],
			{ cwd: resource, env },
		);
		await step(ctx, 'resource-only import', 'node', ['--eval', RESOURCE_CHECK], {
			cwd: resource,
			env,
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
	ctx.log(`Verified ${version} from ${ctx.registry}. Next: node scripts/release.mjs promote`);
}

/** The dist-tags of one package, or an empty object when it is not published. */
async function distTags(ctx, name) {
	const result = await ctx.run('npm', [
		'view',
		name,
		'dist-tags',
		'--json',
		'--registry',
		ctx.registry,
	]);
	if (result.status !== 0) return {};
	try {
		return JSON.parse(result.stdout);
	} catch {
		return {};
	}
}

/** Point `latest` at the staged version for every package. Idempotent. */
export async function promote(ctx, options = {}) {
	const version = options.version ?? sharedVersion(ctx.packages);
	for (const entry of ctx.packages) {
		const { name } = entry.manifest;
		if (!(await alreadyPublished(ctx.run, ctx.registry, name, version))) {
			throw new Error(`${name}@${version} is not on ${ctx.registry}. Run stage first.`);
		}
	}
	requireToken(ctx, options);
	await requireApproval(
		ctx,
		options,
		`Set ${PROMOTE_TAG} on ${ctx.registry} for:\n${list(ctx.packages, version)}`,
	);
	await withTokenConfig(ctx.registry, ctx.env, async (userconfig) => {
		for (const entry of ctx.packages) await promoteOne(ctx, entry, version, options, userconfig);
	});
}

async function promoteOne(ctx, entry, version, options, userconfig) {
	const { name } = entry.manifest;
	if ((await distTags(ctx, name))[PROMOTE_TAG] === version) {
		ctx.log(`skip    ${name}@${version} (already ${PROMOTE_TAG})`);
		return;
	}
	const args = ['dist-tag', 'add', `${name}@${version}`, PROMOTE_TAG, '--registry', ctx.registry];
	if (userconfig) args.push('--userconfig', userconfig);
	// npm reads the one-time code from an argument. It expires in seconds.
	if (options.otp) args.push('--otp', options.otp);
	ctx.log(`promote ${name}@${version} to ${PROMOTE_TAG}`);
	const result = await ctx.run('npm', args, { stdio: 'inherit', env: ctx.env });
	if (result.status !== 0) throw new Error(`Failed to promote ${name}@${version}.`);
}

/** Print the dist-tags of every package. */
export async function status(ctx) {
	for (const entry of ctx.packages) {
		const { name } = entry.manifest;
		const tags = Object.entries(await distTags(ctx, name));
		const shown = tags.length === 0 ? 'not published' : tags.map(([k, v]) => `${k}=${v}`).join(' ');
		ctx.log(`${name}  ${shown}`);
	}
}

const COMMANDS = { stage, verify, promote, status };

async function main(argv) {
	const [command, ...rest] = argv;
	const action = COMMANDS[command];
	if (action === undefined) {
		throw new Error('Usage: node scripts/release.mjs stage|verify|promote|status [options]');
	}
	const ctx = await defaultContext(rest);
	await action(ctx, {
		dryRun: rest.includes('--dry-run'),
		yes: rest.includes('--yes'),
		skipGate: rest.includes('--skip-gate'),
		otp: readFlag(rest, '--otp'),
		version: readFlag(rest, '--version'),
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
