/**
 * The cases every bash backend (`BashBackend`) must pass. A bash backend supplies a
 * `WorkspaceEnv` (`docs/workspace.md`), and the tools the neutral layer
 * builds over it assume one rule set: how a path resolves, how an error
 * comes back, how an aborted command differs from a timed-out one, how a
 * bounded command view carries its truncation.
 *
 * A case is a name and a `run` that throws on failure. The suite needs no
 * test framework and loads no just-bash, so any backend runs it, and the
 * memory and directory backends run it first (`test/conformance.test.ts`).
 *
 * ```ts
 * describe.each(backends)('$name', (fixture) => {
 * 	for (const c of workspaceConformance(fixture)) it(c.name, c.run);
 * });
 * ```
 */

import {
	type ConformanceCase,
	type ConformanceFixture,
	check,
	conformanceSuite,
} from '@ambionframework/ambion/conformance';
import type { BashBackend, WorkspaceEnv } from './backend.ts';
import { FileError, ShellError, type ShellOutputView } from './port.ts';

export type {
	GitConformanceBackend,
	GitConformanceOptions,
	GitConformancePair,
	GitConformanceProbe,
	GitConformanceShared,
	GitConformanceStore,
	GitConformanceTemplate,
} from './git-conformance.ts';
export { gitConformance } from './git-conformance.ts';
export type { ObjectConformanceStore } from './object-conformance.ts';
export { objectConformance } from './object-conformance.ts';
export { type ConformanceCase, type ConformanceFixture, check, conformanceSuite };

/** A bash backend that a case connects to, and how the case releases it. */
export interface WorkspaceConformanceStore {
	readonly backend: BashBackend;
	dispose(): Promise<void>;
}

// -- the cases ----------------------------------------------------------------

type Body = (env: WorkspaceEnv) => Promise<void>;

async function renameReplacesTarget(env: WorkspaceEnv): Promise<void> {
	await env.writeFile('source.txt', 'new');
	await env.writeFile('target.txt', 'old');
	const renamed = await env.renameFile('source.txt', 'target.txt');
	check(renamed.ok, 'renameFile refused to replace an existing target');
	const target = await env.readTextFile('target.txt');
	check(target.ok && target.value === 'new', 'the target kept its old content');
	const source = await env.readTextFile('source.txt');
	check(!source.ok && source.error.code === 'not_found', 'the source is still there after rename');
}

async function recursiveCreateDir(env: WorkspaceEnv): Promise<void> {
	const created = await env.createDir('a/b/c', { recursive: true });
	check(created.ok, 'createDir with recursive did not create the missing parents');
	const info = await env.fileInfo('a/b/c');
	check(info.ok && info.value.kind === 'directory', 'the deepest directory is missing');
	const parent = await env.fileInfo('a/b');
	check(parent.ok && parent.value.kind === 'directory', 'a missing parent was not created');
}

async function forcedRemove(env: WorkspaceEnv): Promise<void> {
	const onMissing = await env.remove('never-existed', { force: true });
	check(onMissing.ok, 'remove with force failed on a missing path');
	await env.createDir('tree/inner', { recursive: true });
	await env.writeFile('tree/inner/leaf.txt', 'x');
	const removed = await env.remove('tree', { recursive: true });
	check(removed.ok, 'recursive remove did not remove the tree');
	const gone = await env.exists('tree');
	check(gone.ok && gone.value === false, 'the tree is still there after a recursive remove');
}

async function fileErrorCodes(env: WorkspaceEnv): Promise<void> {
	const missing = await env.readTextFile('missing.txt');
	check(
		!missing.ok && missing.error instanceof FileError && missing.error.code === 'not_found',
		'a missing file did not answer not_found',
	);
	await env.createDir('a-dir', undefined);
	const asFile = await env.readTextFile('a-dir');
	check(
		!asFile.ok && asFile.error instanceof FileError && asFile.error.code === 'is_directory',
		'reading a directory did not answer is_directory',
	);
	await env.writeFile('a-file.txt', 'x');
	const asDir = await env.listDir('a-file.txt');
	check(
		!asDir.ok && asDir.error instanceof FileError && asDir.error.code === 'not_directory',
		'listing a file did not answer not_directory',
	);
}

async function rangeReads(env: WorkspaceEnv): Promise<void> {
	await env.writeFile('range.txt', 'abcdefghij');
	const cases: readonly [number, number, string][] = [
		[2, 3, 'cde'],
		[0, 100, 'abcdefghij'],
		[8, 5, 'ij'],
		[10, 3, ''],
		[40, 3, ''],
		[4, 0, ''],
	];
	for (const [start, length, expected] of cases) {
		const range = await env.readRange('range.txt', start, length);
		const text = range.ok ? new TextDecoder().decode(range.value) : range.error.message;
		check(text === expected, `readRange(${start}, ${length}) gave ${JSON.stringify(text)}`);
	}
	await env.createDir('range-dir', undefined);
	const asDirectory = await env.readRange('range-dir', 0, 4);
	check(
		!asDirectory.ok && asDirectory.error.code === 'is_directory',
		'a range read of a directory did not answer is_directory',
	);
	const missing = await env.readRange('range-missing.txt', 0, 4);
	check(
		!missing.ok && missing.error.code === 'not_found',
		'a range read of a missing file did not answer not_found',
	);
}

async function tildeAndRelativePaths(env: WorkspaceEnv): Promise<void> {
	const home = env.cwd;
	const tilde = await env.absolutePath('~');
	check(tilde.ok && tilde.value === home, '~ did not expand to the home');
	const tildePath = await env.absolutePath('~/x');
	check(tildePath.ok && tildePath.value === `${home}/x`, '~/x did not expand under the home');
	const relative = await env.absolutePath('y');
	check(relative.ok && relative.value === `${home}/y`, 'a relative path did not resolve under cwd');
}

async function abortApartFromTimeout(env: WorkspaceEnv): Promise<void> {
	const controller = new AbortController();
	const aborting = env.exec('sleep 5', undefined, controller.signal);
	controller.abort();
	const aborted = await aborting;
	check(
		!aborted.ok && aborted.error instanceof ShellError && aborted.error.code === 'aborted',
		'an aborted signal did not answer ShellError code aborted',
	);
	const timedOut = await env.exec('sleep 5', { timeout: 0.05 });
	check(
		!timedOut.ok && timedOut.error instanceof ShellError && timedOut.error.code === 'timeout',
		'a timeout did not answer ShellError code timeout',
	);
}

async function boundedOutput(env: WorkspaceEnv): Promise<void> {
	const views: ShellOutputView[] = [];
	const tail = await env.exec('printf "%s\\n" a b c d e', {
		capture: { limits: { maxBytes: 1_000_000, maxLines: 2 } },
		onUpdate: (view) => views.push(view),
	});
	check(tail.ok, 'the bounded command failed to run');
	check(views.length === 1, `onUpdate received ${views.length} views, expected one`);
	const view = views[0];
	check(view?.truncation.truncated === true, 'the view lacks truncation metadata');
	check(view?.text === 'd\ne', 'the default tail view kept the wrong lines');
	const headViews: ShellOutputView[] = [];
	const head = await env.exec('printf "%s\\n" a b c d e', {
		capture: { limits: { maxBytes: 1_000_000, maxLines: 2, retain: 'head' } },
		onUpdate: (view) => headViews.push(view),
	});
	check(head.ok, 'the head-retained command failed to run');
	const headView = headViews[0];
	check(headView?.truncation.truncated === true, 'a head-retained command was not truncated');
	check(headView?.text === 'a\nb', 'the head-retained view kept the wrong lines');
}

const CASES: readonly [string, Body][] = [
	['renameFile replaces an existing target', renameReplacesTarget],
	['createDir with recursive creates missing parent directories', recursiveCreateDir],
	['remove succeeds with force on a missing path, and recursive removes a tree', forcedRemove],
	['classifies not_found, is_directory, and not_directory as FileError codes', fileErrorCodes],
	['readRange gives the bytes of a range, and a directory or a missing file fails', rangeReads],
	['~ and ~/x expand to the home, and a relative path resolves under cwd', tildeAndRelativePaths],
	['tells an aborted signal apart from a timeout', abortApartFromTimeout],
	['bounds exec output for onUpdate, with truncation metadata', boundedOutput],
];

/** Connects one agent to the backend of the store, runs `body`, and cleans the agent up. */
const connected =
	(body: Body) =>
	async ({ backend }: WorkspaceConformanceStore): Promise<void> => {
		const env = await backend.connect({ name: 'conformance' });
		try {
			await body(env);
		} finally {
			await env.cleanup();
		}
	};

/**
 * The cases every `BashBackend` must pass. The order is stable and the
 * names are the contract. `open` runs inside every case, so a directory
 * backend can mint its own temporary root and clean it up after.
 */
export function workspaceConformance(
	fixture: ConformanceFixture<WorkspaceConformanceStore>,
): readonly ConformanceCase[] {
	return conformanceSuite(
		fixture,
		CASES.map(([name, body]) => [name, connected(body)] as const),
	);
}
