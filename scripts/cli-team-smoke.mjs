#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
/** Check a packed CLI in a project outside the repository. */
import { chmod, cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

async function packFixture(destination) {
	await mkdir(destination);
	const archiveDirectory = join(destination, '.ambion-packages');
	await mkdir(archiveDirectory);
	run('pnpm', ['build'], ROOT);
	const archives = {};
	for (const name of ['journal', 'pi-journal', 'ambion', 'cloudflare', 'cli']) {
		const directory = join(ROOT, 'packages', name);
		const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
		run('pnpm', ['pack', '--pack-destination', archiveDirectory], directory);
		archives[manifest.name] =
			`${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
	}
	const overrides = Object.fromEntries(
		Object.entries(archives).map(([name, filename]) => [name, `file:.ambion-packages/${filename}`]),
	);
	await writeFile(
		join(destination, 'package.json'),
		`${JSON.stringify(
			{
				name: 'ambion-packed-consumer',
				version: '0.0.0',
				private: true,
				type: 'module',
				packageManager: 'pnpm@10.20.0',
				scripts: { 'check:types': 'tsc --noEmit' },
				dependencies: Object.fromEntries(
					Object.entries(archives).map(([name, filename]) => [
						name,
						`file:.ambion-packages/${filename}`,
					]),
				),
				devDependencies: {
					'@types/node': '26.2.0',
					typescript: '7.0.2',
				},
				pnpm: { overrides },
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		join(destination, 'tsconfig.json'),
		`${JSON.stringify(
			{
				compilerOptions: {
					target: 'ES2022',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					strict: true,
					noEmit: true,
					skipLibCheck: true,
				},
				include: ['src'],
			},
			null,
			2,
		)}\n`,
	);
	await mkdir(join(destination, 'src'));
	await writeFile(
		join(destination, 'src', 'index.ts'),
		"import { PACKAGE_NAME } from '@ambionframework/ambion';\nimport type { Env } from '@ambionframework/cloudflare';\n\nconst name: string = PACKAGE_NAME;\nconst env: Env | undefined = undefined;\nvoid name;\nvoid env;\n",
	);
	return archives;
}

async function installAndCheck(destination, archives) {
	const manifest = JSON.parse(await readFile(join(destination, 'package.json'), 'utf8'));
	if (JSON.stringify(manifest).includes('workspace:'))
		throw new Error('The packed consumer contains a workspace dependency.');
	for (const [name, filename] of Object.entries(archives)) {
		const packed = capture(
			'tar',
			['-xOf', join(destination, '.ambion-packages', filename), 'package/package.json'],
			destination,
		);
		if (packed.status !== 0 || packed.output.includes('workspace:'))
			throw new Error(`Packed ${name} contains a workspace dependency.`);
	}
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], destination);
	run('pnpm', ['check:types'], destination);
	const version = capture('pnpm', ['exec', 'ambion', '--version'], destination);
	if (version.status !== 0 || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n?$/.test(version.output))
		throw new Error(`The packed CLI did not report a version: ${version.output}`);
}

async function checkNewCommand(destination, target, archives) {
	const created = capture('pnpm', ['exec', 'ambion', 'new', target], destination);
	if (created.status !== 0 || !created.output.includes(`Created ${target}`))
		throw new Error(`The CLI could not create a project: ${created.output}`);
	const generatedPath = join(target, 'package.json');
	const generated = JSON.parse(await readFile(generatedPath, 'utf8'));
	if (JSON.stringify(generated).includes('workspace:'))
		throw new Error('The new project contains a workspace dependency.');
	const npmrc = await readFile(join(target, '.npmrc'), 'utf8');
	if (!npmrc.includes('@ambionframework:registry=https://npm.pkg.github.com'))
		throw new Error('The new project is missing its package registry configuration.');
	const wrangler = JSON.parse(await readFile(join(target, 'wrangler.jsonc'), 'utf8'));
	const bindings = wrangler.durable_objects?.bindings;
	if (
		!Array.isArray(bindings) ||
		!bindings.some((binding) => binding.name === 'ROOM' && binding.class_name === 'RoomObject') ||
		!bindings.some((binding) => binding.name === 'SEAT' && binding.class_name === 'SeatObject')
	)
		throw new Error('The new project is missing its Cloudflare Durable Object bindings.');
	const overwrite = capture('pnpm', ['exec', 'ambion', 'new', target], destination);
	if (overwrite.status === 0 || !overwrite.output.includes('overwrite'))
		throw new Error('The CLI accepted an existing project directory.');
	await installCreatedProject(destination, target, generated, generatedPath, archives);
}

async function installCreatedProject(destination, target, generated, generatedPath, archives) {
	const overrides = Object.fromEntries(
		[
			'@ambionframework/ambion',
			'@ambionframework/cloudflare',
			'@ambionframework/cli',
			'@ambionframework/journal',
			'@ambionframework/pi-journal',
		].map((name) => {
			const filename = archives[name];
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
	run('pnpm', ['exec', 'wrangler', 'deploy', '--dry-run'], target);
}

async function smoke() {
	const parent = await mkdtemp(join(tmpdir(), 'ambion-team-smoke-'));
	const destination = join(parent, 'team');
	const live = process.argv.includes('--live');
	const keep = process.argv.includes('--keep');
	let credentialPath;
	try {
		const archives = await packFixture(destination);
		await installAndCheck(destination, archives);
		const created = join(parent, 'created-team');
		await checkNewCommand(destination, created, archives);
		credentialPath = await writeCredential(created, live);
		if (live) run('pnpm', ['exec', 'ambion', 'dev'], created);
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
