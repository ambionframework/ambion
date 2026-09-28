/**
 * The S3 tier: `s3ObjectBackend` against MinIO in Docker. `test/s3/setup.sh`
 * starts the server and writes the file that `AMBION_S3` names; without it,
 * every test skips. The tier proves what only a real server can: the
 * SigV4 signature, the conditional put, the checksum header, and that a
 * workspace keeps no copy of a snapshot on its bash filesystem.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { snapshotUri } from '@ambionframework/ambion';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { AwsClient } from 'aws4fetch';
import { beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import { memoryBackend } from '../../../just-bash/src/index.ts';
import { objectConformance } from '../../src/conformance.ts';
import { openWorkspace } from '../../src/index.ts';
import { type S3ObjectBackendOptions, s3ObjectBackend } from '../../src/s3-entry.ts';
import { callAs, toolOf } from '../support/backends.ts';

const configPath = process.env.AMBION_S3;
const ctx = BACKGROUND_CONTEXT;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function settings(): Promise<S3ObjectBackendOptions> {
	return JSON.parse(await readFile(configPath ?? '', 'utf8')) as S3ObjectBackendOptions;
}

/** A client of the same server, for what the backend does not do: make a bucket, change an object. */
function raw(options: S3ObjectBackendOptions): AwsClient {
	return new AwsClient({
		accessKeyId: options.accessKeyId,
		secretAccessKey: options.secretAccessKey,
		service: 's3',
		region: options.region,
		retries: 0,
	});
}

/** The backend over a fresh prefix, so each case reads its own objects alone. */
async function fresh(): Promise<S3ObjectBackendOptions> {
	return { ...(await settings()), prefix: `case-${randomBytes(6).toString('hex')}/` };
}

describe.skipIf(configPath === undefined)('the object backend on MinIO', () => {
	beforeAll(async () => {
		const options = await settings();
		const made = await raw(options).fetch(`${options.endpoint}/${options.bucket}`, {
			method: 'PUT',
		});
		// 409 is a bucket that an earlier run made.
		expect([200, 409]).toContain(made.status);
	});

	for (const c of objectConformance({
		name: 'minio',
		open: async () => {
			const options = await fresh();
			return {
				backend: s3ObjectBackend(options),
				reopen: async () => s3ObjectBackend(options),
				dispose: async () => undefined,
			};
		},
	}))
		it(c.name, c.run);

	it('keeps an object past the 10 MiB that a just-bash directory reads in one file', async () => {
		const backend = s3ObjectBackend(await fresh());
		const env = await backend.connect({ name: 'host' });
		const bytes = new Uint8Array(16 * 1024 * 1024).map((_, index) => index % 253);
		const digest = createHash('sha256').update(bytes).digest('hex');
		await env.put(digest, bytes);
		expect(Buffer.from((await env.get(digest)) ?? []).equals(Buffer.from(bytes))).toBe(true);
	});

	it('refuses a bad credential with the code the server gives', async () => {
		const options = { ...(await fresh()), secretAccessKey: 'wrong' };
		const env = await s3ObjectBackend(options).connect({ name: 'host' });
		await expect(env.get(sha256('x'))).rejects.toThrow(/failed with 403 \(SignatureDoesNotMatch/);
	});

	it('snapshots and fetches through the bucket, keeps no copy on the bash filesystem, and refuses a changed object', async () => {
		const options = await fresh();
		const workspace = openWorkspace({
			name: 'lab',
			backend: { bash: memoryBackend(), objects: s3ObjectBackend(options) },
		});
		onTestFinished(() => workspace.dispose());
		await workspace.use({ name: 'analyst' }, (env) =>
			env.writeFile('/home/analyst/plan.md', 'pour on Thursday\n', ctx),
		);
		const [ref = ''] = await workspace.snapshot(['plan.md'], { agent: { name: 'analyst' } });
		const digest = sha256('pour on Thursday\n');
		expect(ref).toBe(snapshotUri('lab', digest, '/home/analyst/plan.md'));
		expect(await workspace.use(workspace.host, (env) => env.exists('/snapshots', ctx))).toEqual({
			ok: true,
			value: false,
		});
		const fetched = await toolOf(workspace, 'fetch').invoke({ ref }, callAs('reviewer'));
		expect(fetched).toMatchObject({
			details: { path: `/home/reviewer/snapshots/${digest}/plan.md`, bytes: 17 },
		});
		// The host credential can still overwrite an object; the digest check refuses it.
		const url = `${options.endpoint}/${options.bucket}/${options.prefix}${digest}`;
		const forged = await raw(options).fetch(url, { method: 'PUT', body: 'forged\n' });
		expect(forged.status).toBe(200);
		await expect(workspace.readSnapshot(ref)).rejects.toThrow(/changed after the snapshot/);
	});
});
