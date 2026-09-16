#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/** Check a packed CLI in a project outside the repository. */
import { chmod, cp, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from './packages.mjs';

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
}

function capture(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
	if (result.error) throw result.error;
	return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

async function providerKey() {
	try {
		const key = (await readFile(resolve(homedir(), '.anthropic/dev-key'), 'utf8')).trim();
		return key === '' ? undefined : key;
	} catch {
		return undefined;
	}
}

async function writeCredential(destination, live) {
	if (!live) return undefined;
	const key = await providerKey();
	if (key === undefined) throw new Error('Cannot run --live without ~/.anthropic/dev-key.');
	const path = join(destination, '.dev.vars');
	await writeFile(path, `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return path;
}

async function installAndCheck(destination) {
	const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
	if (JSON.stringify(manifest).includes('workspace:'))
		throw new Error('The packed consumer contains a workspace dependency.');
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], destination);
	run('pnpm', ['check:types'], destination);
	const version = capture('pnpm', ['exec', 'ambion', '--version'], destination);
	if (version.status !== 0 || !/^\d+\.\d+\.\d+\n?$/.test(version.output))
		throw new Error(`The packed CLI did not report a version: ${version.output}`);
}

async function checkNewCommand(destination, target) {
	const created = capture('pnpm', ['exec', 'ambion', 'new', target], destination);
	if (created.status !== 0 || !created.output.includes(`Created ${target}`))
		throw new Error(`The CLI could not create a project: ${created.output}`);
	const generatedPath = join(target, 'package.json');
	const generated = JSON.parse(await readFile(generatedPath, 'utf8'));
	if (JSON.stringify(generated).includes('workspace:'))
		throw new Error('The new project contains a workspace dependency.');
	const overwrite = capture('pnpm', ['exec', 'ambion', 'new', target], destination);
	if (overwrite.status === 0 || !overwrite.output.includes('overwrite'))
		throw new Error('The CLI accepted an existing project directory.');
	await installCreatedProject(destination, target, generated, generatedPath);
}

async function installCreatedProject(destination, target, generated, generatedPath) {
	const archives = await readdir(join(destination, '.ambion-packages'));
	const overrides = Object.fromEntries(
		[
			'@ambionframework/ambion',
			'@ambionframework/cloudflare',
			'@ambionframework/cli',
			'@ambionframework/journal',
		].map((name) => {
			const filename = archives.find((entry) =>
				entry.startsWith(name.replace('@', '').replace('/', '-')),
			);
			if (filename === undefined) throw new Error(`No local archive exists for ${name}.`);
			return [name, `file:.ambion-packages/${filename}`];
		}),
	);
	await cp(join(destination, '.ambion-packages'), join(target, '.ambion-packages'), {
		recursive: true,
	});
	for (const section of [generated.dependencies, generated.devDependencies]) {
		for (const name of Object.keys(section ?? {})) {
			if (overrides[name]) section[name] = overrides[name];
		}
	}
	generated.pnpm = { ...generated.pnpm, overrides };
	await writeFile(generatedPath, `${JSON.stringify(generated, null, '\t')}\n`);
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], target);
	run('pnpm', ['check:types'], target);
}

async function smoke() {
	const parent = await mkdtemp(join(tmpdir(), 'ambion-team-smoke-'));
	const destination = join(parent, 'team');
	const live = process.argv.includes('--live');
	const keep = process.argv.includes('--keep');
	let credentialPath;
	try {
		run('node', [join(ROOT, 'scripts/prepare-team.mjs'), destination], ROOT);
		credentialPath = await writeCredential(destination, live);
		await installAndCheck(destination);
		await checkNewCommand(destination, join(parent, 'created-team'));
		if (live) run('pnpm', ['exec', 'ambion', 'dev'], destination);
		console.log(`Packed consumer smoke passed: ${destination}`);
	} finally {
		if (credentialPath) await unlink(credentialPath).catch(() => undefined);
		if (!keep) await rm(parent, { recursive: true, force: true });
	}
}

smoke().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
