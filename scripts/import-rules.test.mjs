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
import { dirname, join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const biome = join(root, 'node_modules', '.bin', 'biome');

/** [the folder the probe sits in, the import, whether a rule refuses it] */
const CASES = [
	// A package outside the core reaches it through its published entries.
	['packages/claude/src', '@ambionframework/ambion', false],
	['packages/claude/src', '@ambionframework/ambion/hosting', false],
	['packages/claude/src', '@ambionframework/ambion/conformance', false],
	['packages/claude/src', '@ambionframework/ambion/testing', true],
	['packages/claude/src', '@ambionframework/ambion/src/room.ts', true],
	['packages/claude/src', '../../ambion/src/room.ts', true],
	['packages/pi/src', '@ambionframework/ambion/testing', true],
	['packages/codex/src', '../../ambion/src/room.ts', true],
	['packages/cloudflare/src', '@ambionframework/ambion/hosting', false],
	['examples/workbench/src', '@ambionframework/ambion/testing', true],
	['examples/workbench/src', '../../../packages/ambion/src/room.ts', true],
	// The workspace reaches the core the same way, and loads no just-bash.
	['packages/workspace/src', '@ambionframework/ambion', false],
	['packages/workspace/src', '@ambionframework/ambion/testing', true],
	['packages/workspace/src', 'just-bash', true],
	['packages/workspace/src', '@ambionframework/just-bash', true],
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
];

/** The probe files Biome refused, by the path of each in the copied tree. */
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
	const refused = output.matchAll(/^(\S+\.ts):\d+:\d+ lint\/style\/noRestrictedImports/gm);
	return new Set([...refused].map((match) => match[1]));
}

test('the import rules refuse each import they name, and pass each published entry', () => {
	const tree = mkdtempSync(join(tmpdir(), 'ambion-import-rules-'));
	try {
		copyFileSync(join(root, 'biome.jsonc'), join(tree, 'biome.jsonc'));
		const probes = CASES.map(([folder, specifier, refuse], index) => {
			const path = `${folder}/import-probe-${index}.ts`;
			mkdirSync(dirname(join(tree, path)), { recursive: true });
			writeFileSync(join(tree, path), `import * as m from '${specifier}';\nexport const y = m;\n`);
			return { path, specifier, refuse };
		});
		const refused = refusedProbes(tree);
		for (const { path, specifier, refuse } of probes) {
			const verb = refuse ? 'refuse' : 'pass';
			assert.equal(
				refused.has(path),
				refuse,
				`${dirname(path)}: the rules do not ${verb} ${specifier}`,
			);
		}
	} finally {
		rmSync(tree, { recursive: true, force: true });
	}
});
