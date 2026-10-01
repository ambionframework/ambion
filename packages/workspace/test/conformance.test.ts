/**
 * The conformance suites. The workspace cases run on the just-bash memory
 * backend, which proves the suite itself; `@ambionframework/just-bash` and
 * `@ambionframework/workstation` run them on their own backends. The object
 * cases run on the default file store over the memory and the directory
 * backends; the S3 tier runs them on MinIO. The SQL cases run in
 * `sqlite.test.ts`.
 */

import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import { backends, tempDir } from '../../just-bash/test/support/backends.ts';
import type { BashBackend } from '../src/backend.ts';
import {
	type ConformanceFixture,
	type ObjectConformanceStore,
	objectConformance,
	workspaceConformance,
} from '../src/conformance.ts';
import { fileObjectBackend } from '../src/object-files.ts';
import { openResource } from '../src/resource.ts';
import { retainSensorObservation } from '../src/sensor-retention.ts';
import { createRestoreTool } from '../src/snapshots.ts';
import { callAs } from './support/backends.ts';

const memory = backends.find((fixture) => fixture.name === 'memory');
if (memory === undefined) throw new Error('The just-bash fixtures have no memory backend.');

describe.each([memory])('$name', (fixture) => {
	for (const c of workspaceConformance(fixture)) it(c.name, c.run);
});

/** The default file store at /snapshots over a bash backend under its own resource. */
function fileStore(bash: () => BashBackend) {
	const open = () => {
		const resource = openResource({ name: 'objects', backend: bash() });
		const backend = fileObjectBackend({
			bash: resource.use,
			mirrorAgent: { name: 'objects-host' },
			root: '/snapshots',
		});
		return { backend: { ...backend, dispose: () => resource.dispose() } };
	};
	return open;
}

const objectStores: ConformanceFixture<ObjectConformanceStore>[] = [
	{
		name: 'file store on memory',
		open: async () => {
			const { backend } = fileStore(() => memoryBackend())();
			return { backend, dispose: async () => backend.dispose() };
		},
	},
	{
		name: 'file store on a directory',
		open: async () => {
			const { dir, dispose } = await tempDir('ambion-objects-');
			const open = fileStore(() => directoryBackend(dir));
			const { backend } = open();
			return {
				backend,
				reopen: async () => open().backend,
				dispose: async () => {
					await backend.dispose();
					await dispose();
				},
			};
		},
	},
];

describe.each(objectStores)('$name', (fixture) => {
	for (const c of objectConformance(fixture)) it(c.name, c.run);
	it('retains a sensor manifest and restores its referenced file through the object backend', async () => {
		const opened = await fixture.open();
		const resource = openResource({ name: 'retention-conformance-bash', backend: memoryBackend() });
		const objects = openResource({
			name: 'retention-conformance-objects',
			backend: opened.backend,
		});
		const snapshotStore = {
			workspace: 'retention-conformance',
			mirrorAgent: { name: 'retention-host' },
			bash: resource.use,
			objects: objects.use,
		};
		const bytes = new Uint8Array([7, 0, 255, 9]);
		const digest = createHash('sha256').update(bytes).digest('hex');
		try {
			const retained = await retainSensorObservation(
				snapshotStore,
				{ name: 'observer' },
				{
					sensor: 'bench-one/file',
					process: 'bash-666666666666',
					connection: { name: 'bench-one', owner: 'sensor-owner', port: 43127 },
					request: { api: 1 },
					source: { repository: 'test/sensor', commit: 'd'.repeat(40), dirty: true },
				},
				{
					api: 1,
					observations: [
						{
							at: '2026-09-29T10:00:01.000Z',
							parts: [{ kind: 'file', file: digest, name: '../unsafe.csv', mediaType: 'text/csv' }],
						},
					],
				},
				new Map([[digest, bytes]]),
			);
			const restored = await createRestoreTool(snapshotStore).invoke(
				{ ref: retained.manifestRef },
				callAs('reviewer'),
			);
			const manifestPath = (restored as { details: { path: string } }).details.path;
			const manifestText = await resource.use({ name: 'reviewer' }, async (env) => {
				const result = await env.readTextFile(manifestPath);
				if (!result.ok) throw result.error;
				return result.value;
			});
			const manifest = JSON.parse(manifestText) as typeof retained.manifest;
			const file = manifest.files[0];
			if (!file) throw new Error('The retained manifest has no file ref.');
			if (!retained.files[0]?.path.endsWith('/file-001.bin'))
				throw new Error('The source filename was used as the local export filename.');
			if (
				manifest.observations[0]?.parts[0]?.kind !== 'file' ||
				manifest.observations[0].parts[0].name !== '../unsafe.csv'
			)
				throw new Error('The manifest did not preserve the source filename as metadata.');
			const fileResult = await createRestoreTool(snapshotStore).invoke(
				{ ref: file.ref },
				callAs('reviewer'),
			);
			const filePath = (fileResult as { details: { path: string } }).details.path;
			const restoredBytes = await resource.use({ name: 'reviewer' }, async (env) => {
				const result = await env.readBinaryFile(filePath);
				if (!result.ok) throw result.error;
				return result.value;
			});
			if (!Buffer.from(restoredBytes).equals(Buffer.from(bytes)))
				throw new Error('The restored sensor file changed through the object backend.');
		} finally {
			await objects.dispose();
			await resource.dispose();
			await opened.dispose();
		}
	});
});
