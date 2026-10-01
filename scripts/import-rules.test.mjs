/**
 * The import rules in `biome.jsonc` refuse what they name.
 *
 * Biome reads each `noRestrictedImports` group as a gitignore pattern. A
 * pattern that matches nothing passes every import, and Biome says nothing:
 * the extglob `@ambionframework/ambion/!(hosting|conformance)` refused no
 * import at all. This test lints one probe file for each case in a copy of
 * the tree, and checks which imports the rules refuse.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const biome = join(root, 'node_modules', '.bin', 'biome');

/**
 * The model libraries and platform modules that every file of the core
 * refuses. Each layer override repeats them, so each layer probe holds them.
 */
const CORE_BANS = [
	'@earendil-works/pi-agent-core',
	'@ambionframework/pi',
	'cloudflare:workers',
	'node:sqlite',
	'node:fs',
	'node:fs/promises',
	'@earendil-works/pi-ai/providers/all',
	'@ambionframework/pi/testing',
].map((specifier) => [specifier, true]);

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
	['packages/assistant/src', '@ambionframework/pi', false],
	['packages/assistant/src', '@ambionframework/ambion/testing', true],
	['packages/assistant/src', '@ambionframework/ambion/src/room.ts', true],
	['packages/assistant/src', '../../ambion/src/room.ts', true],
	// The workspace reaches the core the same way, and loads no just-bash.
	['packages/workspace/src', '@ambionframework/ambion', false],
	['packages/workspace/src', '@ambionframework/ambion/testing', true],
	['packages/workspace/src', 'just-bash', true],
	['packages/workspace/src', '@ambionframework/just-bash', true],
	[
		'packages/workspace/src',
		['@ambionframework/just-bash', '@ambionframework/ambion'],
		true,
		'backend.ts',
	],
	// The five neutral files hold the same rule. `git-backend.ts` and
	// `object-backend.ts` once matched the override of the whole package.
	...['git-backend.ts', 'object-backend.ts'].map((file) => [
		'packages/workspace/src',
		[
			['@ambionframework/ambion', true],
			['./tools.ts', true],
			['just-bash', true],
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
	// The just-bash backends know the workspace interface and no room.
	['packages/just-bash/src', '@ambionframework/workspace', false],
	['packages/just-bash/src', '@ambionframework/workspace/resource', false],
	['packages/just-bash/src', 'just-bash', false],
	['packages/just-bash/src', '@ambionframework/workspace/sqlite', true],
	['packages/just-bash/src', '../../workspace/src/audit.ts', true],
	['packages/just-bash/src', '@ambionframework/ambion', true],
	['packages/just-bash/src', 'node:sqlite', true],
	['packages/just-bash/src', '@ambionframework/workspace/git', true],
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
	// The journal sits below everything.
	['packages/journal/src', '@ambionframework/ambion', true],
	['packages/journal/src', '../../ambion/src/room.ts', true],
	// The core names no model library and no platform module.
	['packages/ambion/src', '@earendil-works/pi-agent-core', true],
	['packages/ambion/src', 'node:sqlite', true],
	// Each layer of the core refuses the layers above it, and reaches those below.
	[
		'packages/ambion/src',
		[
			...CORE_BANS,
			['./host/runtime.ts', true],
			['./journal/journal.ts', true],
			['./room/fold.ts', true],
			['./execution/runner.ts', true],
			['./room-host/core.ts', true],
			['./room.ts', true],
			['./errors.ts', false],
		],
		null,
		'types.ts',
	],
	[
		'packages/ambion/src/host',
		[
			...CORE_BANS,
			['../journal/journal.ts', true],
			['../room/fold.ts', true],
			['../execution/runner.ts', true],
			['../room.ts', true],
			['../execution/executor.ts', false],
			['../types.ts', false],
		],
		null,
	],
	[
		'packages/ambion/src/journal',
		[
			...CORE_BANS,
			['../host/runtime.ts', true],
			['../protocol.ts', true],
			['../room/fold.ts', true],
			['../execution/runner.ts', true],
			['../room.ts', true],
			['../types.ts', false],
		],
		null,
	],
	[
		'packages/ambion/src/room',
		[
			...CORE_BANS,
			['../host/runtime.ts', true],
			['../execution/runner.ts', true],
			['../room-host/core.ts', true],
			['../room.ts', true],
			['../journal/journal.ts', false],
			['../protocol.ts', false],
		],
		null,
	],
	[
		'packages/ambion/src',
		[
			...CORE_BANS,
			['./host/runtime.ts', true],
			['./execution/runner.ts', true],
			['./room-host/core.ts', true],
			['./room.ts', true],
			['./room/fold.ts', false],
			['./journal/journal.ts', false],
		],
		null,
		'answers.ts',
	],
	[
		'packages/ambion/src/execution',
		[
			...CORE_BANS,
			['../journal/journal.ts', true],
			['../room/fold.ts', true],
			['../room-host/core.ts', true],
			['../room.ts', true],
			['../host/runtime.ts', false],
			['../protocol.ts', false],
		],
		null,
	],
	[
		'packages/ambion/src',
		[
			...CORE_BANS,
			['./journal/journal.ts', true],
			['./room/fold.ts', true],
			['./room-host/core.ts', true],
			['./room.ts', true],
			['./execution/runner.ts', false],
			['./protocol.ts', false],
		],
		null,
		'conformance-support.ts',
	],
	[
		'packages/ambion/src/testing',
		[
			...CORE_BANS,
			['../journal/journal.ts', true],
			['../room/fold.ts', true],
			['../room.ts', true],
			['../room-host/core.ts', true],
			['../execution/executor.ts', false],
			['../host/runtime.ts', false],
		],
		null,
	],
	[
		'packages/ambion/src/room-host',
		[
			...CORE_BANS,
			['../execution/runner.ts', true],
			['../room.ts', true],
			['../room/fold.ts', false],
			['../journal/journal.ts', false],
			['./core.ts', false],
		],
		null,
	],
	// The entry files hold the same ban.
	['packages/ambion/src', CORE_BANS, null, 'hosting.ts'],
];

/** The number of restricted-import diagnostics for each probe path. */
function refusedProbes(tree) {
	let output = '';
	try {
		execFileSync(biome, ['lint', '.', '--vcs-enabled=false', '--max-diagnostics=none'], {
			cwd: tree,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
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
			const imports = (Array.isArray(value) ? value : [value]).map((item) =>
				Array.isArray(item) ? item : [item, refuse],
			);
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
