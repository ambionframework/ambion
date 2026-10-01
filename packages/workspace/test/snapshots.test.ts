/**
 * Snapshots: the refs a workspace gives for its files, the objects it keeps
 * in the default file store, `restore`, and the refusals. The `snapshot` tool
 * in a running room is in `workspace.test.ts`; the object backend's own
 * cases are in `conformance.test.ts`.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshotUri, snapshotUri } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it, onTestFinished } from 'vitest';
import { roomName as name } from '../../ambion/test/support/room.ts';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { openWorkspace, SNAPSHOT_LIMITS, type Workspace } from '../src/index.ts';
import { assertObjectSize } from '../src/object-rules.ts';
import { s3ObjectBackend } from '../src/s3-entry.ts';
import { callAs, toolOf } from './support/backends.ts';

const ctx = BACKGROUND_CONTEXT;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** A memory workspace that the test disposes at its end. */
function site(label: string): Workspace {
	const workspace = openWorkspace({ name: name(label), backend: { bash: memoryBackend() } });
	onTestFinished(() => workspace.dispose());
	return workspace;
}

/** Write `content` to `path` as `agent`. */
async function put(workspace: Workspace, agent: string, path: string, content: string) {
	await workspace.use({ name: agent }, async (env) => {
		const made = await env.createDir(path.slice(0, path.lastIndexOf('/')) || '/', undefined, ctx);
		if (!made.ok) throw made.error;
		const written = await env.writeFile(path, content, ctx);
		if (!written.ok) throw written.error;
	});
}

describe('snapshot', () => {
	it('gives one ref for each path, in order, and the same bytes give the same copy, through a link too', async () => {
		const workspace = site('snapshot-refs');
		await put(workspace, 'analyst', '/shared/a.md', 'alpha\n');
		await put(workspace, 'analyst', '/shared/b.md', 'alpha\n');
		await workspace.use({ name: 'analyst' }, (env) =>
			env.exec('ln -s /shared/a.md /shared/link.md', undefined, ctx),
		);
		const refs = await workspace.snapshot(['/shared/a.md', '/shared/b.md', '/shared/link.md']);
		expect(refs).toEqual([
			snapshotUri(workspace.name, sha256('alpha\n'), '/shared/a.md'),
			snapshotUri(workspace.name, sha256('alpha\n'), '/shared/b.md'),
			snapshotUri(workspace.name, sha256('alpha\n'), '/shared/link.md'),
		]);
		expect(await workspace.snapshot(['/shared/a.md'])).toEqual(refs.slice(0, 1));
		const copies = await workspace.use(workspace.mirrorAgent, (env) =>
			env.listDir('/snapshots', ctx),
		);
		expect(copies.ok && copies.value.map((entry) => entry.name)).toEqual([sha256('alpha\n')]);
	});

	it('takes a file past 10 MiB on the memory backend: the object store sets the limit', async () => {
		const workspace = site('snapshot-large');
		const large = 'x'.repeat(12 * 1024 * 1024);
		await put(workspace, 'analyst', '/shared/large.bin', large);
		const [ref = ''] = await workspace.snapshot(['/shared/large.bin']);
		expect((await workspace.readSnapshot(ref)).byteLength).toBe(large.length);
	});

	it('keeps the bytes of a ref when the file changes, and a new snapshot gives a new ref', async () => {
		const workspace = site('snapshot-immutable');
		await put(workspace, 'analyst', '/home/analyst/report.md', 'draft\n');
		const [first] = await workspace.snapshot(['report.md'], { agent: { name: 'analyst' } });
		expect(parseSnapshotUri(first ?? '')).toEqual({
			workspace: workspace.name,
			digest: sha256('draft\n'),
			path: '/home/analyst/report.md',
		});
		await put(workspace, 'analyst', '/home/analyst/report.md', 'final\n');
		const [second] = await workspace.snapshot(['/home/analyst/report.md']);
		expect(second).not.toBe(first);
		expect(text(await workspace.readSnapshot(first ?? ''))).toBe('draft\n');
		expect(text(await workspace.readSnapshot(second ?? ''))).toBe('final\n');
	});

	it('keeps a ref readable after the workspace closes and opens again on disk', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-snapshot-'));
		onTestFinished(() => rm(root, { recursive: true, force: true }));
		const label = name('snapshot-disk');
		const first = openWorkspace({ name: label, backend: { bash: directoryBackend(root) } });
		await put(first, 'analyst', '/shared/plan.md', 'pour on Thursday\n');
		const [ref] = await first.snapshot(['/shared/plan.md']);
		await first.dispose();
		const again = openWorkspace({ name: label, backend: { bash: directoryBackend(root) } });
		onTestFinished(() => again.dispose());
		expect(text(await again.readSnapshot(ref ?? ''))).toBe('pour on Thursday\n');
	});

	const deep = `/${Array.from({ length: 9 }, () => 'd'.repeat(240)).join('/')}/f.md`;
	/** The files a case writes first, beside `/shared/a.md`. */
	const fixtures: Record<string, () => string> = {
		'/shared/a.md': () => 'alpha\n',
		[deep]: () => 'deep\n',
	};
	it.each([
		{ paths: [], error: /at least one path/ },
		{
			paths: Array.from({ length: SNAPSHOT_LIMITS.count + 1 }, () => '/shared/a.md'),
			error: /at most 16 paths/,
		},
		{ paths: [' '], error: /nonblank/ },
		{ paths: ['/shared/a.md', '/shared/../shared/a.md'], error: /names \/shared\/a\.md twice/ },
		{ paths: ['/shared/a.md', '/shared/missing.md'], error: /Cannot read \/shared\/missing\.md/ },
		{ paths: ['/shared'], error: /\/shared is not a file/ },
		{ paths: [deep], error: /a ref has at most 2048/ },
	])('refuses $paths.length path(s) and writes no copy: $error', async ({ paths, error }) => {
		const workspace = site('snapshot-refused');
		await put(workspace, 'analyst', '/shared/a.md', 'alpha\n');
		for (const path of new Set(paths)) {
			const content = fixtures[path];
			if (content !== undefined) await put(workspace, 'analyst', path, content());
		}
		await expect(workspace.snapshot(paths)).rejects.toThrow(error);
		expect(
			await workspace.use(workspace.mirrorAgent, (env) => env.exists('/snapshots', ctx)),
		).toMatchObject({ ok: true, value: false });
	});
});

/** The two ways to read a snapshot: the host's `readSnapshot`, and the agent's `restore`. */
const readers: [string, (workspace: Workspace, ref: string) => Promise<unknown>][] = [
	['readSnapshot', (workspace, ref) => workspace.readSnapshot(ref)],
	[
		'restore',
		(workspace, ref) =>
			Promise.resolve(toolOf(workspace, 'restore').invoke({ ref }, callAs('reviewer'))),
	],
];

describe.each(readers)('%s', (_name, read) => {
	it.each([
		{ ref: 'https://x/a', error: /is not a snapshot ref/ },
		{
			ref: snapshotUri('elsewhere', sha256('alpha\n'), '/shared/a.md'),
			error: /names the workspace 'elsewhere'/,
		},
		{ ref: 'tampered', error: /changed after the snapshot/ },
		{ ref: 'unknown', error: /The object store holds no bytes for/ },
	])('refuses $ref', async ({ ref, error }) => {
		const workspace = site('snapshot-read');
		await put(workspace, 'analyst', '/shared/a.md', 'alpha\n');
		const [taken] = await workspace.snapshot(['/shared/a.md']);
		// just-bash has no wall between accounts, so an agent can change a copy.
		await put(workspace, 'analyst', `/snapshots/${sha256('alpha\n')}`, 'forged\n');
		const named = {
			tampered: taken ?? '',
			unknown: snapshotUri(workspace.name, sha256('never'), '/shared/a.md'),
		}[ref];
		await expect(read(workspace, named ?? ref)).rejects.toThrow(error);
	});
});

describe('restore', () => {
	it("puts the bytes of a ref in the caller's files, at the default path or at its own", async () => {
		const workspace = site('snapshot-restore');
		await put(workspace, 'analyst', '/home/analyst/plan.md', 'pour on Thursday\n');
		const [ref = ''] = await workspace.snapshot(['/home/analyst/plan.md']);
		await put(workspace, 'analyst', '/home/analyst/plan.md', 'changed\n');
		const digest = sha256('pour on Thursday\n');
		const restore = toolOf(workspace, 'restore');
		const restored = await restore.invoke({ ref }, callAs('reviewer'));
		const into = `/home/reviewer/snapshots/${digest}/plan.md`;
		expect(restored).toMatchObject({
			content: [{ text: `Wrote the 17 bytes of ${ref} to ${into}.` }],
			details: { ref, path: into, bytes: 17 },
		});
		await restore.invoke({ ref, path: 'review/plan.md' }, callAs('reviewer'));
		const read = (path: string) =>
			workspace.use({ name: 'reviewer' }, (env) => env.readTextFile(path, ctx));
		expect(await read(into)).toEqual({ ok: true, value: 'pour on Thursday\n' });
		expect(await read('/home/reviewer/review/plan.md')).toEqual({
			ok: true,
			value: 'pour on Thursday\n',
		});
	});
});

describe('the object limits', () => {
	it('follow S3: one PutObject of 5 GiB, and a key of 1024 bytes, in a path-style URL by default', () => {
		expect(SNAPSHOT_LIMITS.bytes).toBe(5 * 1024 ** 3);
		expect(() => assertObjectSize('/big', SNAPSHOT_LIMITS.bytes)).not.toThrow();
		expect(() => assertObjectSize('/big', SNAPSHOT_LIMITS.bytes + 1)).toThrow(
			'/big holds 5.0 GiB, more than the 5 GiB that an object holds.',
		);
		const options = {
			endpoint: 'http://127.0.0.1:9000',
			region: 'us-east-1',
			bucket: 'b',
			accessKeyId: 'k',
			secretAccessKey: 's',
		};
		expect(() => s3ObjectBackend({ ...options, prefix: 'p'.repeat(960) })).not.toThrow();
		expect(() => s3ObjectBackend({ ...options, prefix: 'p'.repeat(961) })).toThrow(RangeError);
		for (const prefix of ['lab?x=/', 'lab#/', 'lab dir/', 'lab%2F'])
			expect(() => s3ObjectBackend({ ...options, prefix })).toThrow(/characters S3 calls safe/);
		expect(s3ObjectBackend({ ...options, prefix: 'lab/', pathStyle: false }).label).toBe(
			'http://b.127.0.0.1:9000/lab/',
		);
		expect(s3ObjectBackend({ ...options, prefix: 'lab/' }).label).toBe(
			'http://127.0.0.1:9000/b/lab/',
		);
	});
});

/**
 * Three answers of S3 that MinIO in the S3 tier does not give on demand: a
 * 403 head from a credential without s3:ListBucket, a 409 while a
 * concurrent conditional put is in progress, and a 412 when a concurrent
 * put stored the bytes first. A local server gives them in turn.
 */
describe('the S3 put', () => {
	it('takes a 403 head as a missing object, sends the bytes again after a 409, and takes a 412 as stored', async () => {
		const answers = [403, 409, 403, 200];
		const seen: string[] = [];
		const headers: Record<string, string | undefined>[] = [];
		const server = createServer((request, response) => {
			request.resume();
			const status = answers.shift() ?? 500;
			seen.push(`${request.method} ${status}`);
			if (request.method === 'PUT')
				headers.push({
					condition: request.headers['if-none-match'] as string | undefined,
					checksum: request.headers['x-amz-checksum-sha256'] as string | undefined,
				});
			response.writeHead(status).end();
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
		const { port } = server.address() as AddressInfo;
		const backend = s3ObjectBackend({
			endpoint: `http://127.0.0.1:${port}`,
			region: 'us-east-1',
			bucket: 'b',
			accessKeyId: 'k',
			secretAccessKey: 's',
			retries: 0,
		});
		const env = await backend.connect({ name: 'host' });
		await env.put(sha256('alpha\n'), new TextEncoder().encode('alpha\n'));
		expect(seen).toEqual(['HEAD 403', 'PUT 409', 'HEAD 403', 'PUT 200']);
		expect(headers.at(-1)).toEqual({
			condition: '*',
			checksum: createHash('sha256').update('alpha\n').digest('base64'),
		});
		answers.push(404, 412);
		await env.put(sha256('gamma\n'), new TextEncoder().encode('gamma\n'));
		expect(seen.slice(-2)).toEqual(['HEAD 404', 'PUT 412']);
		answers.push(403, 409, 403, 409, 403, 409);
		await expect(env.put(sha256('beta\n'), new TextEncoder().encode('beta\n'))).rejects.toThrow(
			/The put of .* failed with 409/,
		);
	});
});
