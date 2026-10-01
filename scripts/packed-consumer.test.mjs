/**
 * A consumer of the workspace, the workstation, or just-bash installs no Pi
 * package.
 *
 * A host with Claude or Codex seats must not load Pi to use a workspace. The
 * check packs each package as its tarball, as `pnpm publish` does, and reads
 * the manifest in the tarball. It then lists the production dependencies of
 * the package from the lockfile, through `pnpm list`. A consumer of the
 * tarball installs this closure: `pnpm pack` changes `workspace:*` ranges to
 * the release version, and nothing else. The check needs no network and no
 * install of its own.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './packages.mjs';

const PI = '@earendil-works/';
const PACKAGES = ['workspace', 'workstation', 'just-bash'];
const SECTIONS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/** The names in one tree of `pnpm list --json`, at every depth. */
function namesIn(projects) {
	const names = new Set();
	const visit = (node) => {
		for (const section of ['dependencies', 'optionalDependencies']) {
			for (const [name, child] of Object.entries(node[section] ?? {})) {
				names.add(name);
				visit(child);
			}
		}
	};
	for (const project of projects) visit(project);
	return names;
}

/** The names of one list that are Pi packages. */
const piPackages = (names) => [...names].filter((name) => name.startsWith(PI)).sort();

const output = (command, args, options = {}) =>
	execFileSync(command, args, {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024,
		stdio: ['ignore', 'pipe', 'pipe'],
		...options,
	});

test('the closure finder reads every depth, and finds a Pi package', () => {
	const tree = [
		{ dependencies: { a: { dependencies: { [`${PI}pi-ai`]: { dependencies: {} } } } } },
	];
	assert.deepEqual(piPackages(namesIn(tree)), [`${PI}pi-ai`]);
	assert.deepEqual(piPackages(namesIn([{ dependencies: { a: {} } }])), []);
});

for (const name of PACKAGES) {
	test(`the packed ${name} tarball and its dependency closure hold no Pi package`, () => {
		const directory = join(ROOT, 'packages', name);
		const scratch = mkdtempSync(join(tmpdir(), 'ambion-packed-'));
		try {
			const packed = JSON.parse(
				output('pnpm', ['pack', '--pack-destination', scratch, '--json'], { cwd: directory }),
			);
			const manifest = JSON.parse(
				output('tar', ['-xzOf', packed.filename, 'package/package.json']),
			);
			for (const section of SECTIONS) {
				assert.deepEqual(
					piPackages(Object.keys(manifest[section] ?? {})),
					[],
					`${section} of ${name}`,
				);
			}
			const listed = JSON.parse(
				output(
					'pnpm',
					['--filter', manifest.name, 'list', '--prod', '--depth', 'Infinity', '--json'],
					{ cwd: ROOT },
				),
			);
			assert.ok(namesIn(listed).size > 0, `the list of ${name} is empty`);
			assert.deepEqual(piPackages(namesIn(listed)), [], `closure of ${name}`);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
