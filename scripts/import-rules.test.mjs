/**
 * The import rules in `biome.jsonc` refuse what they name.
 *
 * Biome reads each `noRestrictedImports` group as a gitignore pattern. A
 * pattern that matches nothing passes every import, and Biome says nothing:
 * the extglob `@ambionframework/ambion/!(hosting|conformance)` refused no
 * import at all. This test lints one probe file for each case in a copy of
 * the tree, and checks which imports the rules refuse. The cases for the
 * core come from the table of layers in `scripts/core-layers.mjs`.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, join, normalize } from 'node:path';
import test from 'node:test';
import { CORE_LAYERS } from './core-layers.mjs';

const root = new URL('..', import.meta.url).pathname;
const biome = join(root, 'node_modules', '.bin', 'biome');
const coreSource = 'packages/ambion/src';

/**
 * The model libraries and platform modules that every file of the core
 * refuses. Each layer override repeats them, so each layer probe holds them.
 */
const CORE_BANS = [
	'@earendil-works/pi-durable',
	'@ambionframework/pi',
	'cloudflare:workers',
	'node:sqlite',
	'node:fs',
	'node:fs/promises',
	'@earendil-works/pi-ai/providers/all',
	'@ambionframework/pi/testing',
].map((specifier) => [specifier, true]);

/**
 * The path of a probe file for a glob of the table. A plain file is itself,
 * `dir/**` is `dir/probe.ts`, and `name*.ts` is `name-probe.ts`.
 */
function sampleOf(glob) {
	if (/^[\w-]+(\.[\w-]+)*\/\*\*$/.test(glob)) return `${glob.slice(0, -2)}/probe.ts`;
	if (/^[\w-]+\*\.ts$/.test(glob)) return `${glob.replace('*', '-probe')}`;
	if (/^[\w-]+(\/[\w-]+)*\.ts$/.test(glob)) return glob;
	throw new Error(
		`The table of layers holds a glob of a shape that the test cannot probe: ${glob}`,
	);
}

/** The relative specifier from the folder of one core file to another. */
function specifierBetween(from, to) {
	const relative = path.posix.relative(path.posix.dirname(from), to);
	return relative.startsWith('.') ? relative : `./${relative}`;
}

/**
 * One probe file for each glob of each layer. A probe imports the core bans,
 * and a file of every layer, its own layer included. The rules refuse the
 * file of a layer that is neither its own nor in its `imports`. The entry
 * files have no layer override. Their probes pass the override of
 * `packages/ambion/src/**` alone, which refuses the core bans only.
 */
function coreCases() {
	const names = new Set(CORE_LAYERS.map((layer) => layer.name));
	return CORE_LAYERS.flatMap((layer) => {
		for (const name of layer.imports) {
			assert.ok(names.has(name), `the layer ${layer.name} imports the unknown layer ${name}`);
		}
		return layer.files.map((glob) => {
			const file = sampleOf(glob);
			const targets = CORE_LAYERS.flatMap((target) =>
				target.files
					.map(sampleOf)
					.filter((sample) => sample !== file)
					.map((sample) => [
						specifierBetween(file, sample),
						target !== layer && !layer.imports.includes(target.name),
					]),
			);
			return [
				`${coreSource}/${path.posix.dirname(file)}`,
				[...CORE_BANS, ...targets],
				null,
				path.posix.basename(file),
			];
		});
	});
}

/**
 * [the folder the probe sits in, the import, whether a rule refuses it, the
 * file name]. The import is one specifier or a list. An item of a list is a
 * specifier, which takes the refusal of the case, or a pair of a specifier
 * and its own refusal. A pair lets one probe file hold both a refused and a
 * passed import, which an override that names one file needs. The case then
 * has `null` for its refusal. The file name is optional.
 */
const CASES = [
	// A package outside the core reaches it through its published entries.
	['packages/claude/src', '@ambionframework/ambion', false],
	['packages/claude/src', '@ambionframework/ambion/hosting', false],
	['packages/claude/src', '@ambionframework/ambion/conformance', false],
	['packages/claude/src', '@ambionframework/ambion/testing', true],
	['packages/claude/src', '@ambionframework/ambion/src/room.ts', true],
	['packages/claude/src', '../../ambion/src/room.ts', true],
	['packages/pi/src', '@ambionframework/ambion/testing', true],
	// The Pi test entry builds on the core test entry.
	['packages/pi/src', '@ambionframework/ambion/testing', false, 'testing.ts'],
	['packages/codex/src', '../../ambion/src/room.ts', true],
	['packages/cloudflare/src', '@ambionframework/ambion/hosting', false],
	['packages/simulator/src', '@ambionframework/ambion', false],
	['packages/simulator/src', '@ambionframework/ambion/testing', true],
	['packages/simulator/src', '../../ambion/src/room.ts', true],
	['examples/workbench/src', '@ambionframework/ambion/testing', true],
	['examples/workbench/src', '../../../packages/ambion/src/room.ts', true],
	// The assistant reaches the core the same way.
	['packages/assistant/src', '@ambionframework/ambion', false],
	['packages/assistant/src', '@ambionframework/ambion/testing', true],
	['packages/assistant/src', '@ambionframework/ambion/src/room.ts', true],
	['packages/assistant/src', '../../ambion/src/room.ts', true],
	// The runtimes reach the core the same way.
	['packages/compose/src', '@ambionframework/ambion', false],
	['packages/compose/src', '@ambionframework/ambion/conformance', false],
	['packages/compose/src', '@ambionframework/ambion/testing', true],
	['packages/compose/src', '@ambionframework/ambion/src/room.ts', true],
	['packages/compose/src', '../../ambion/src/room.ts', true],
	// The child of `processRuntime` imports `node:` built-ins and the setup
	// script, and no other file.
	[
		'packages/compose/src',
		[
			['node:readline', false],
			['node:vm', false],
			['./guest.ts', false],
			['./quickjs.ts', true],
			['./crossing.ts', true],
			['@ambionframework/ambion', true],
			['quickjs-emscripten', true],
			['../../ambion/src/room.ts', true],
		],
		null,
		'child.ts',
	],
	// The workspace reaches the core the same way, and loads no just-bash.
	['packages/workspace/src', '@ambionframework/ambion', false],
	['packages/workspace/src', '@ambionframework/ambion/testing', true],
	['packages/workspace/src', 'just-bash', true],
	['packages/workspace/src', '@ambionframework/just-bash', true],
	// The workspace owns its port: it imports no Pi package, in any file.
	['packages/workspace/src', '@earendil-works/pi-durable', true],
	['packages/workspace/src', '@earendil-works/pi-ai', true],
	[
		'packages/workspace/src',
		['@ambionframework/just-bash', '@ambionframework/ambion', '@earendil-works/pi-durable'],
		true,
		'backend.ts',
	],
	// Four of the five neutral files hold the same rule, and `backend.ts`
	// has its own case above. `git-backend.ts` and `object-backend.ts` once
	// matched the override of the whole package.
	...['resource.ts', 'resource-entry.ts', 'git-backend.ts', 'object-backend.ts'].map((file) => [
		'packages/workspace/src',
		[
			['@ambionframework/ambion', true],
			['./tools.ts', true],
			['just-bash', true],
			['@earendil-works/pi-durable', true],
			['./resource.ts', false],
		],
		null,
		file,
	]),
	// The workstation knows the workspace interface, the git helpers, and no room.
	['packages/workstation/src', '@ambionframework/workspace', false],
	['packages/workstation/src', '@ambionframework/workspace/resource', false],
	['packages/workstation/src', '@ambionframework/workspace/git', false],
	['packages/workstation/src', '@ambionframework/workspace/sqlite', true],
	['packages/workstation/src', '@ambionframework/just-bash', true],
	['packages/workstation/src', '@ambionframework/ambion', true],
	['packages/workstation/src', 'node:sqlite', true],
	['packages/workstation/src', 'just-bash/browser', true],
	['packages/workstation/src', '@ambionframework/just-bash/git', true],
	['packages/workstation/src', '@ambionframework/ambion/hosting', true],
	['packages/workstation/src', '@earendil-works/pi-durable', true],
	// The just-bash backends know the workspace interface and no room.
	['packages/just-bash/src', '@ambionframework/workspace', false],
	['packages/just-bash/src', '@ambionframework/workspace/resource', false],
	['packages/just-bash/src', 'just-bash', false],
	['packages/just-bash/src', '@ambionframework/workspace/sqlite', true],
	['packages/just-bash/src', '../../workspace/src/audit.ts', true],
	['packages/just-bash/src', '@ambionframework/ambion', true],
	['packages/just-bash/src', 'node:sqlite', true],
	['packages/just-bash/src', '@ambionframework/workspace/git', true],
	['packages/just-bash/src', '@earendil-works/pi-durable', true],
	// The git backend of just-bash knows the workspace interface and no room,
	// and it alone loads just-git's server and node:sqlite.
	['packages/just-bash/src/git', '@ambionframework/workspace', false],
	['packages/just-bash/src/git', '@ambionframework/workspace/resource', false],
	['packages/just-bash/src/git', '@ambionframework/workspace/git', false],
	['packages/just-bash/src/git', 'just-git/server', false],
	['packages/just-bash/src/git', 'just-git/repo', false],
	['packages/just-bash/src/git', 'node:sqlite', false],
	['packages/just-bash/src/git', '@ambionframework/workspace/sqlite', true],
	['packages/just-bash/src/git', '@ambionframework/just-bash', true],
	['packages/just-bash/src/git', '@ambionframework/ambion', true],
	['packages/just-bash/src/git', 'just-bash/browser', true],
	['packages/just-bash/src/git', '@ambionframework/just-bash/git', true],
	['packages/just-bash/src/git', '@ambionframework/ambion/hosting', true],
	['packages/just-bash/src/git', '@earendil-works/pi-durable', true],
	// The journal sits below everything.
	['packages/journal/src', '@ambionframework/ambion', true],
	['packages/journal/src', '../../ambion/src/room.ts', true],
	['packages/journal/src', '@earendil-works/pi-ai/providers/all', true],
	['packages/journal/src', '@ambionframework/workspace/resource', true],
	// The core cases come from the table of layers.
	...coreCases(),
	// `room-run/core.ts` holds the rules of its layer, and imports no file
	// beside it.
	[
		`${coreSource}/room-run`,
		[
			...coreCases().find(([folder]) => folder.startsWith(`${coreSource}/room-run`))[1],
			['./dispatch.ts', true],
			['./waits.ts', true],
		],
		null,
		'core.ts',
	],
];

/** The number of restricted-import diagnostics for each probe path. */
function refusedProbes(tree) {
	let output = '';
	try {
		execFileSync(biome, ['lint', '.', '--vcs-enabled=false', '--max-diagnostics=none'], {
			cwd: tree,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			// The diagnostics of every probe outgrow the default buffer of 1 MiB.
			maxBuffer: 64 * 1024 * 1024,
		});
	} catch (error) {
		output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
	}
	const refused = output.matchAll(/^(\S+\.ts):(\d+):\d+ lint\/style\/noRestrictedImports/gm);
	const lines = new Map();
	for (const match of refused) {
		const path = match[1];
		if (!path) continue;
		const found = lines.get(path) ?? new Set();
		found.add(match[2]);
		lines.set(path, found);
	}
	return lines;
}

test('the import rules refuse each import they name, and pass each published entry', () => {
	const tree = mkdtempSync(join(tmpdir(), 'ambion-import-rules-'));
	try {
		copyFileSync(join(root, 'biome.jsonc'), join(tree, 'biome.jsonc'));
		const paths = new Set();
		const probes = CASES.map(([folder, value, refuse, file], index) => {
			const path = normalize(`${folder}/${file ?? `import-probe-${index}.ts`}`);
			assert.ok(!paths.has(path), `two cases write the probe file ${path}`);
			paths.add(path);
			const imports = (Array.isArray(value) ? value : [value]).map((item) => {
				assert.ok(
					Array.isArray(item) || refuse !== null,
					`the case ${index} for ${path} has a bare import ${item} and a null refusal: list the pairs`,
				);
				return Array.isArray(item) ? item : [item, refuse];
			});
			assert.ok(imports.length > 0, `the case ${index} for ${path} has no import`);
			assert.ok(
				imports.every(([specifier]) => specifier !== ''),
				`the case ${index} for ${path} has an empty import`,
			);
			mkdirSync(dirname(join(tree, path)), { recursive: true });
			const source = imports
				.map(([specifier], importIndex) => `import * as m${importIndex} from '${specifier}';`)
				.join('\n');
			writeFileSync(join(tree, path), `${source}\n`);
			return { path, imports };
		});
		const refused = refusedProbes(tree);
		const misses = [];
		for (const { path, imports } of probes) {
			imports.forEach(([specifier, refuse], importIndex) => {
				if ((refused.get(path)?.has(String(importIndex + 1)) ?? false) !== refuse) {
					misses.push(`${path}: the rules do not ${refuse ? 'refuse' : 'pass'} ${specifier}`);
				}
			});
		}
		assert.deepEqual(misses, []);
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});

/** Every `.ts` file under a folder, as paths relative to it. */
function sourceFiles(folder, base = folder) {
	return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
		const full = join(folder, entry.name);
		if (entry.isDirectory()) return sourceFiles(full, base);
		return entry.name.endsWith('.ts') ? [path.relative(base, full).split(path.sep).join('/')] : [];
	});
}

test('every file of the core belongs to exactly one layer', () => {
	const bad = sourceFiles(join(root, coreSource)).flatMap((file) => {
		const layers = CORE_LAYERS.filter(
			(layer) =>
				layer.files.some((glob) => path.matchesGlob(file, glob)) &&
				!(layer.exclude ?? []).includes(file),
		);
		return layers.length === 1
			? []
			: [`${file}: ${layers.map((layer) => layer.name).join(', ') || 'no layer'}`];
	});
	assert.deepEqual(bad, []);
});

test('the layer comment of biome.jsonc lists each layer of the table', () => {
	const lines = readFileSync(join(root, 'biome.jsonc'), 'utf8')
		.split('\n')
		.map((line) => line.trim());
	const missing = CORE_LAYERS.filter(
		(layer) => !lines.includes(`//   ${layer.files.join(', ')}  ${layer.about}`),
	).map((layer) => layer.name);
	assert.deepEqual(missing, []);
});
