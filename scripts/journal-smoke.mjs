#!/usr/bin/env node
/** Check journal packages in consumers outside the workspace. Build first. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishablePackages, ROOT, sharedVersion } from './packages.mjs';

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}.`);
}

async function pack(name, destination) {
	const directory = join(ROOT, 'packages', name);
	const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
	run('pnpm', ['pack', '--pack-destination', destination], directory);
	return `file:${join(destination, `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`)}`;
}

async function consumer(directory, dependencies, source, skipLibCheck) {
	await mkdir(directory);
	await writeFile(
		join(directory, 'package.json'),
		JSON.stringify({
			private: true,
			type: 'module',
			packageManager: 'pnpm@10.20.0',
			dependencies,
			devDependencies: { typescript: '7.0.2', '@types/node': '26.2.0' },
			pnpm: { overrides: dependencies },
		}),
	);
	await writeFile(join(directory, 'index.ts'), source);
	await writeFile(
		join(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'NodeNext',
				types: ['node'],
				strict: true,
				noEmit: true,
				skipLibCheck,
			},
			include: ['index.ts'],
		}),
	);
	run('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile=false'], directory);
	run('pnpm', ['exec', 'tsc'], directory);
	run(process.execPath, ['index.ts'], directory);
}

async function smoke() {
	const packages = await publishablePackages();
	sharedVersion(packages);
	if (!packages.some((entry) => entry.manifest.name === '@ambionframework/pi-journal'))
		throw new Error('Release discovery omitted pi-journal.');
	const directory = await mkdtemp(join(tmpdir(), 'ambion-journal-smoke-'));
	try {
		const journal = await pack('journal', directory);
		const piJournal = await pack('pi-journal', directory);
		await consumer(
			join(directory, 'generic'),
			{ '@ambionframework/journal': journal },
			`import assert from 'node:assert/strict';
import { Journal, memoryJournals, type Vocabulary } from '@ambionframework/journal';
const vocabulary: Vocabulary<'note' | 'run'> = {
  run: 'run',
  accepts: (kind): kind is 'note' | 'run' => kind === 'note' || kind === 'run',
};
const journal = new Journal(memoryJournals().open('test'), vocabulary);
const result = await journal.append('note', { decide: () => ({ body: { text: 'hello' } }) });
assert.ok('entry' in result);
assert.equal(result.entry.kind, 'note');
for (const name of ['@earendil-works/pi-agent-core', '@ambionframework/pi-journal', '@ambionframework/ambion']) {
  assert.throws(() => import.meta.resolve(name), { code: 'ERR_MODULE_NOT_FOUND' });
}
await assert.rejects(import('@ambionframework/journal/' + 'pi'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
`,
			false,
		);
		await consumer(
			join(directory, 'pi'),
			{ '@ambionframework/journal': journal, '@ambionframework/pi-journal': piJournal },
			`import assert from 'node:assert/strict';
import { memoryJournals } from '@ambionframework/journal';
import { piSessions, type SessionOpener } from '@ambionframework/pi-journal';
const journals = memoryJournals();
const sessions: SessionOpener = piSessions(journals);
const session = await sessions.open('review', 'parent');
const entry = await session.appendEntry({ id: 'note', type: 'custom', customType: 'audit', data: { text: 'hello' } }, 'main');
await session.createLane('branch', entry.id);
await session.setLabel(entry.id, 'keep');
const reopened = await piSessions(journals).open('review');
assert.equal((await reopened.getMetadata()).parentSessionId, 'parent');
assert.equal(await reopened.getLabel(entry.id), 'keep');
assert.equal((await reopened.findEntries({ order: 'oldestFirst' })).length, 1);
assert.deepEqual(await reopened.getLanes(), [{ lane: 'main', leafId: entry.id }, { lane: 'branch', leafId: entry.id }]);
assert.throws(() => import.meta.resolve('@ambionframework/ambion'), { code: 'ERR_MODULE_NOT_FOUND' });
`,
			true,
		);
		console.log('Packed journal consumers passed.');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

smoke().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
