#!/usr/bin/env node
/** Prepare a standalone team project from local package archives. Nothing is published. */
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ROOT } from './packages.mjs';

const PACKAGES = ['journal', 'ambion', 'cloudflare', 'cli'];

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
}

async function pack(destination) {
	const archives = {};
	for (const name of PACKAGES) {
		const directory = join(ROOT, 'packages', name);
		const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
		run('pnpm', ['pack', '--pack-destination', destination], directory);
		const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
		archives[manifest.name] = filename;
	}
	return archives;
}

async function prepare(destination) {
	const fromRoot = relative(ROOT, destination);
	if (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot)) {
		throw new Error('Choose a destination outside the repository.');
	}
	// Non-recursive creation refuses an existing destination without overwriting it.
	await mkdir(destination);
	run('pnpm', ['build'], ROOT);
	const archiveDirectory = join(destination, '.ambion-packages');
	await mkdir(archiveDirectory);
	const archives = await pack(archiveDirectory);
	const extracted = join(destination, '.ambion-template');
	await mkdir(extracted);
	run(
		'tar',
		['-xzf', join(archiveDirectory, archives['@ambionframework/cli']), '-C', extracted],
		ROOT,
	);
	await cp(join(extracted, 'package/templates/team'), destination, { recursive: true });
	await rm(extracted, { recursive: true });
	await rename(join(destination, 'gitignore'), join(destination, '.gitignore'));
	const path = join(destination, 'package.json');
	const manifest = JSON.parse(await readFile(path, 'utf8'));
	const overrides = Object.fromEntries(
		Object.entries(archives).map(([name, filename]) => [name, `file:.ambion-packages/${filename}`]),
	);
	for (const dependencies of [manifest.dependencies, manifest.devDependencies]) {
		for (const name of Object.keys(dependencies ?? {})) {
			if (overrides[name]) dependencies[name] = overrides[name];
		}
	}
	manifest.pnpm = { ...manifest.pnpm, overrides };
	await writeFile(path, `${JSON.stringify(manifest, null, '\t')}\n`);
	console.log(`Prepared ${destination}. Run pnpm install there, then follow its README.`);
}

const destination = process.argv[2];
if (!destination || process.argv.length !== 3) {
	console.error('Usage: node scripts/prepare-team.mjs /absolute/path/to/new-team');
	process.exitCode = 1;
} else {
	await prepare(resolve(destination)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
