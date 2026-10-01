/**
 * The previews of a snapshot ref and of a commit ref, on a real workspace:
 * a memory backend, and the lab's own git backend in process.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { commitUri } from '@ambionframework/ambion';
import { memoryBackend } from '@ambionframework/just-bash';
import { BACKGROUND_CONTEXT, openWorkspace, type Workspace } from '@ambionframework/workspace';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readCommitFile, readSnapshotFile } from '../src/previews.ts';
import { labRepositories } from '../src/repositories.ts';

const ctx = BACKGROUND_CONTEXT;
const bench = { name: 'bench' };

function lab(): Workspace {
	const workspace = openWorkspace({
		name: 'workbench',
		backend: { bash: memoryBackend({ git: labRepositories(':memory:') }) },
	});
	onTestFinished(() => workspace.dispose());
	return workspace;
}

/** Run `command` as the agent `bench`, and fail the test when it fails. */
async function sh(workspace: Workspace, command: string): Promise<string> {
	let output = '';
	const ran = await workspace.use(bench, (env) =>
		env.exec(
			command,
			{
				timeout: 60,
				capture: { limits: { maxBytes: 100_000, maxLines: 1000 } },
				onUpdate: (update) => {
					if (update.kind === 'replace') output = update.output.text;
				},
			},
			ctx,
		),
	);
	if (!ran.ok || ran.value.exitCode !== 0) throw new Error(`${command} failed: ${output}`);
	return output;
}

/** The bytes of a SQLite database with one table of two rows. */
async function database(): Promise<Uint8Array> {
	const directory = await mkdtemp(join(tmpdir(), 'workbench-preview-'));
	onTestFinished(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, 'runs.db');
	const db = new DatabaseSync(file);
	db.exec(
		"CREATE TABLE runs (id INTEGER, note TEXT); INSERT INTO runs VALUES (1, 'blink'), (2, 'sweep');",
	);
	db.close();
	return new Uint8Array(await readFile(file));
}

describe('the preview of a snapshot', () => {
	it.each([
		['text', '/shared/notes.md', async () => new TextEncoder().encode('pour on Thursday\n')],
		['binary', '/shared/blob.bin', async () => new Uint8Array([1, 0, 2, 0, 3])],
		['database', '/shared/runs.db', database],
		['picture', '/shared/board.png', async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])],
		['large picture', '/shared/scan.png', async () => new Uint8Array(8 * 1_048_576 + 1)],
	])('shows a %s snapshot', async (kind, path, bytes) => {
		const workspace = lab();
		const content = await bytes();
		await workspace.use(bench, async (env) => {
			await env.createDir('/shared', { recursive: true }, ctx);
			await env.writeFile(path, content, ctx);
		});
		const [ref = ''] = await workspace.snapshot([path]);
		const shown = await readSnapshotFile(workspace, ref);
		expect(shown.path).toBe(ref);
		if (kind === 'text') expect(shown.text).toBe('pour on Thursday\n');
		if (kind === 'binary')
			expect(shown.text).toBe('A binary file of 5 bytes. An agent reads it with restore.');
		if (kind === 'database') {
			expect(shown.tables?.map((table) => [table.name, table.count])).toEqual([['runs', 2]]);
		}
		if (kind === 'picture') expect(shown.image?.mimeType).toBe('image/png');
		if (kind === 'large picture')
			expect(shown.text).toBe(
				'A picture of 8388609 bytes. The preview shows one of up to 8 MiB. An agent reads it with restore.',
			);
	});
});

describe('the preview of a commit', () => {
	it('shows the commit, and where its branch points now: still there, moved, or gone', async () => {
		const workspace = lab();
		const fork = await workspace.git?.use(bench, (env) =>
			env.fork('templates/firmware-sketch', 'fw'),
		);
		if (!fork?.ok) throw new Error('The fork failed.');
		await sh(
			workspace,
			`git clone ${fork.repository.url} ~/fw && cd ~/fw && git switch -c blink && echo 250 > period.txt && git add . && git commit -m "Blink faster" && git push origin blink`,
		);
		const ref = await workspace.commitRef('bench/fw', { branch: 'blink' });
		const shown = await readCommitFile(workspace, ref);
		const lines = shown.text.split('\n');
		expect(lines[0]).toBe('bench/fw, branch blink');
		expect(lines).toContain('    Blink faster');
		expect(lines).toContain('Changes (1):');
		expect(lines).toContain('  A period.txt');
		expect(lines.at(-1)).toBe('The branch blink still names this commit.');

		await sh(
			workspace,
			'cd ~/fw && echo 100 > period.txt && git commit -am "Faster" && git push origin blink',
		);
		const moved = await readCommitFile(workspace, ref);
		expect(moved.text).toContain('    Blink faster');
		expect(moved.text.split('\n').at(-1)).toMatch(
			/^The branch blink now names [0-9a-f]{7}; the ref keeps this commit\.$/,
		);

		await sh(workspace, 'cd ~/fw && git push origin --delete blink');
		const gone = await readCommitFile(workspace, ref);
		expect(gone.text.split('\n').at(-1)).toBe(
			'The branch blink no longer exists; the ref keeps this commit.',
		);

		const plain = await readCommitFile(
			workspace,
			commitUri('workbench', 'bench/fw', fork.repository.branches.main ?? ''),
		);
		expect(plain.text.split('\n')[0]).toBe('bench/fw');
		expect(plain.text).toContain('Parent: none: a root commit');
		await expect(
			readCommitFile(workspace, commitUri('workbench', 'bench/fw', '0'.repeat(40))),
		).rejects.toThrow(/holds no commit/);
		// A name that git refuses still shows the commit. It is never a deleted branch.
		const odd = commitUri('workbench', 'bench/fw', fork.repository.branches.main ?? '', {
			branch: 'a..b',
		});
		const refused = await readCommitFile(workspace, odd);
		expect(refused.text.split('\n').at(-1)).toBe(
			'The branch a..b is not a name git accepts; the ref keeps this commit.',
		);
	});
});
