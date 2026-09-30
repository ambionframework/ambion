import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { directoryBackend, memoryBackend } from '../../just-bash/src/index.ts';
import type { BashBackend, WorkspaceEnv } from '../src/backend.ts';
import type { ObjectBackend, ObjectEnv } from '../src/object-backend.ts';
import { fileObjectBackend } from '../src/object-files.ts';
import { openResource } from '../src/resource.ts';
import { retainSensorObservation } from '../src/sensor-retention.ts';
import { createSensorClient, type ObserveResponse } from '../src/sensors.ts';
import type { SnapshotStore } from '../src/snapshots.ts';
import { createRestoreTool } from '../src/snapshots.ts';
import { callAs } from './support/backends.ts';
import { fileBytes, fileDigest, frameBytes, frameDigest } from './support/sensor-blobs.ts';
import { startSensorServer } from './support/sensor-server.ts';

const owner = { name: 'workspace-host' };

async function defaultStore(
	root: string,
	deniedAgent?: string,
): Promise<{ store: SnapshotStore; dispose(): Promise<void> }> {
	const disk = directoryBackend(root);
	const backend: BashBackend = {
		...disk,
		connect: (agent, signal) => disk.connect(agent, signal),
	};
	const shell = openResource<WorkspaceEnv>({
		name: 'retention-shell',
		backend: {
			...backend,
			async connect(agent, signal) {
				if (agent.name === deniedAgent) throw new Error(`Access denied for ${agent.name}.`);
				return backend.connect(agent, signal);
			},
		},
	});
	const objects = openResource<ObjectEnv>({
		name: 'retention-objects',
		backend: fileObjectBackend({ shell: shell.use, host: owner, root: '/snapshots' }),
	});
	return {
		store: { workspace: 'retention-test', host: owner, shell: shell.use, objects: objects.use },
		async dispose() {
			await objects.dispose();
			await shell.dispose();
		},
	};
}

type ExportFailure = 'file-cancel' | 'manifest-write' | 'rename-cancel';

function exportWriteOverride(
	env: WorkspaceEnv,
	agent: string,
	failure: ExportFailure,
	controller: AbortController,
): WorkspaceEnv['writeFile'] | undefined {
	if (agent !== 'observer') return undefined;
	if (failure === 'manifest-write')
		return (...args) => {
			const [path] = args;
			if (typeof path === 'string' && path.endsWith('manifest.json'))
				return Promise.reject(new Error('manifest export write refused'));
			return env.writeFile(...args);
		};
	if (failure !== 'file-cancel') return undefined;
	return (...args) => {
		const [path] = args;
		return env.writeFile(...args).then((result) => {
			if (typeof path === 'string' && path.endsWith('file-001.bin'))
				controller.abort(new Error('cancel during export'));
			return result;
		});
	};
}

function exportRenameOverride(
	env: WorkspaceEnv,
	agent: string,
	failure: ExportFailure,
	controller: AbortController,
): WorkspaceEnv['renameFile'] | undefined {
	if (agent !== 'observer' || failure !== 'rename-cancel') return undefined;
	return (...args) => {
		const [from] = args;
		return env.renameFile(...args).then((result) => {
			if (typeof from === 'string' && from.endsWith('.part'))
				controller.abort(new Error('cancel after rename'));
			return result;
		});
	};
}

function interruptExport(
	env: WorkspaceEnv,
	agent: string,
	failure: ExportFailure,
	controller: AbortController,
): WorkspaceEnv {
	return new Proxy(env, {
		get(target, property) {
			if (property === 'writeFile') {
				const override = exportWriteOverride(env, agent, failure, controller);
				if (override) return override;
			}
			if (property === 'renameFile') {
				const override = exportRenameOverride(env, agent, failure, controller);
				if (override) return override;
			}
			const value = Reflect.get(target, property, target) as unknown;
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

describe('sensor evidence retention', () => {
	it('restores a complete observation and files for another agent after HTTP shutdown', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-retention-'));
		const storeHarness = await defaultStore(root, 'sensor-owner');
		const server = await startSensorServer();
		const client = createSensorClient(server.origin);
		const source = await client.index();
		const request = {
			api: 1 as const,
			span: { from: '2026-09-29T10:00:00.000Z', to: '2026-09-29T10:00:03.000Z' },
		};
		const response = await client.observe('bench', request);
		const files = new Map([
			[fileDigest, (await client.file(fileDigest)).bytes],
			[frameDigest, (await client.file(frameDigest)).bytes],
		]);
		await server.close();

		try {
			const retained = await retainSensorObservation(
				storeHarness.store,
				{ name: 'observer' },
				{
					sensor: 'bench-one/bench',
					process: 'bash-111111111111',
					connection: { name: 'bench-one', owner: 'sensor-owner', port: 43127 },
					request,
					source: { ...source.source, dirty: true },
				},
				response,
				files,
			);
			const repeated = await retainSensorObservation(
				storeHarness.store,
				{ name: 'observer' },
				{
					sensor: 'bench-one/bench',
					process: 'bash-111111111111',
					connection: { name: 'bench-one', owner: 'sensor-owner', port: 43127 },
					request,
					source: { ...source.source, dirty: true },
				},
				response,
				files,
			);
			expect(repeated.directory).not.toBe(retained.directory);
			const restored = await createRestoreTool(storeHarness.store).invoke(
				{ ref: retained.manifestRef },
				callAs('reviewer'),
			);
			const manifestPath = (restored as { details: { path: string } }).details.path;
			const manifestContents = await storeHarness.store.shell({ name: 'reviewer' }, async (env) => {
				const result = await env.readTextFile(manifestPath, BACKGROUND_CONTEXT);
				if (!result.ok) throw result.error;
				return result.value;
			});
			const manifest = JSON.parse(manifestContents) as typeof retained.manifest;
			expect(manifest.observations).toEqual(response.observations);
			expect(manifest.observations[0]?.at).toBe('2026-09-29T10:00:01.000Z');
			expect(manifest.source).toEqual({ ...source.source, dirty: true });
			expect(manifest.request).toEqual(request);
			expect(manifest.connection).toEqual({
				name: 'bench-one',
				owner: 'sensor-owner',
				port: 43127,
			});
			expect(manifest.files).toHaveLength(2);

			for (const item of manifest.files) {
				const result = await createRestoreTool(storeHarness.store).invoke(
					{ ref: item.ref },
					callAs('reviewer'),
				);
				const path = (result as { details: { path: string } }).details.path;
				const bytes = await storeHarness.store.shell({ name: 'reviewer' }, async (env) => {
					const found = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
					if (!found.ok) throw found.error;
					return found.value;
				});
				expect([...bytes]).toEqual([...(item.digest === fileDigest ? fileBytes : frameBytes)]);
			}

			const firstExport = retained.files[0];
			if (!firstExport) throw new Error('Expected a retained file export.');
			await storeHarness.store.shell({ name: 'observer' }, async (env) => {
				const changed = await env.writeFile(firstExport.path, 'edited export', BACKGROUND_CONTEXT);
				if (!changed.ok) throw changed.error;
			});
			const originalAgain = await storeHarness.store.objects(owner, (env) =>
				env.get(firstExport.digest),
			);
			expect(originalAgain).toEqual(files.get(firstExport.digest));
		} finally {
			await storeHarness.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('clones source, request, observations, and bytes before awaiting storage', async () => {
		const inner = memoryBackend();
		const shell = openResource<WorkspaceEnv>({ name: 'retention-mutable-shell', backend: inner });
		let releasePuts = () => {};
		let startedPut = () => {};
		const started = new Promise<void>((resolve) => (startedPut = resolve));
		const gate = new Promise<void>((resolve) => (releasePuts = resolve));
		const delayedBackend: ObjectBackend = {
			store: 'delayed',
			connect: async () => ({
				async put(digest, bytes) {
					startedPut();
					await gate;
					await innerObjects.put(digest, bytes);
				},
				get: (digest) => innerObjects.get(digest),
				cleanup: async () => undefined,
			}),
		};
		const objects = openResource<ObjectEnv>({
			name: 'retention-mutable-objects',
			backend: delayedBackend,
		});
		const innerObjects = await (
			await import('../src/object-files.ts')
		)
			.fileObjectBackend({
				shell: shell.use,
				host: owner,
				root: '/snapshots',
			})
			.connect(owner);
		const store: SnapshotStore = {
			workspace: 'retention-clone',
			host: owner,
			shell: shell.use,
			objects: objects.use,
		};
		const payload = new Uint8Array([1, 2, 3]);
		const response = {
			api: 1 as const,
			observations: [
				{
					at: '2026-09-29T10:00:01.000Z',
					parts: [
						{ kind: 'text' as const, text: 'original' },
						{
							kind: 'file' as const,
							file: createHash('sha256').update(payload).digest('hex'),
							name: 'source-name.csv',
							mediaType: 'text/csv',
						},
					],
				},
			],
		};
		const request = {
			api: 1 as const,
			span: { from: '2026-09-29T10:00:00.000Z', to: '2026-09-29T10:00:03.000Z' },
		};
		const source = { repository: 'test/repo', commit: 'a'.repeat(40), dirty: true };
		const operation = retainSensorObservation(
			store,
			{ name: 'observer' },
			{
				sensor: 'bench-one/bench',
				process: 'bash-222222222222',
				connection: { name: 'bench-one', owner: 'sensor-owner', port: 43128 },
				request,
				source,
			},
			response as ObserveResponse,
			new Map([[createHash('sha256').update(payload).digest('hex'), payload]]),
		);
		await started;
		request.span.from = '2026-09-29T10:00:02.000Z';
		source.commit = 'b'.repeat(40);
		(response.observations[0] as { at: string }).at = '2026-09-29T10:00:02.000Z';
		payload[0] = 9;
		releasePuts();
		const retained = await operation;
		expect(retained.manifest.request.span?.from).toBe('2026-09-29T10:00:00.000Z');
		expect(retained.manifest.source.commit).toBe('a'.repeat(40));
		expect(retained.manifest.observations[0]?.at).toBe('2026-09-29T10:00:01.000Z');
		const bytes = await store.objects(owner, (env) => env.get(retained.files[0]?.digest ?? ''));
		expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
		await objects.dispose();
		await shell.dispose();
	});

	it('retains text-only observations with no received files', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-retention-text-'));
		const storeHarness = await defaultStore(root);
		const metadata = {
			sensor: 'bench-one/bench',
			process: 'bash-777777777777',
			connection: { name: 'bench-one', owner: 'sensor-owner', port: 43132 },
			request: { api: 1 as const },
			source: { repository: 'test/repo', commit: '7'.repeat(40), dirty: true },
		};
		const response: ObserveResponse = {
			api: 1,
			observations: [
				{
					at: '2026-09-29T10:00:01.000Z',
					parts: [{ kind: 'text', text: 'Supply stable.' }],
				},
			],
		};
		try {
			const first = await retainSensorObservation(
				storeHarness.store,
				{ name: 'observer' },
				metadata,
				response,
				new Map(),
			);
			const second = await retainSensorObservation(
				storeHarness.store,
				{ name: 'observer' },
				metadata,
				response,
				new Map(),
			);
			expect(first.files).toEqual([]);
			expect(first.directory).not.toBe(second.directory);
			expect(first.manifest.observations).toEqual(response.observations);
		} finally {
			await storeHarness.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('rejects missing and changed evidence before any object write', async () => {
		const root = await mkdtemp(join(tmpdir(), 'ambion-retention-invalid-'));
		const storeHarness = await defaultStore(root);
		const server = await startSensorServer();
		const client = createSensorClient(server.origin);
		const response = await client.observe('bench');
		await server.close();
		const metadata = {
			sensor: 'bench-one/bench',
			process: 'bash-333333333333',
			connection: { name: 'bench-one', owner: 'observer', port: 43129 },
			request: { api: 1 as const },
			source: { repository: 'test/repo', commit: 'c'.repeat(40), dirty: false },
		};
		try {
			await expect(
				retainSensorObservation(
					storeHarness.store,
					{ name: 'observer' },
					metadata,
					response,
					new Map(),
				),
			).rejects.toThrow(/bytes were not received/);
			await expect(
				retainSensorObservation(
					storeHarness.store,
					{ name: 'observer' },
					{
						...metadata,
						request: {
							api: 1,
							span: { from: '2026-09-29T10:00:03.000Z', to: '2026-09-29T10:00:00.000Z' },
						},
					},
					response,
					new Map([
						[frameDigest, frameBytes],
						[fileDigest, fileBytes],
					]),
				),
			).rejects.toThrow(/request fails/);
			await expect(
				retainSensorObservation(
					storeHarness.store,
					{ name: 'observer' },
					metadata,
					response,
					new Map([
						[frameDigest, new Uint8Array([0])],
						[fileDigest, fileBytes],
					]),
				),
			).rejects.toMatchObject({ name: 'SensorDigestError', expected: frameDigest });
			const noObjects = await storeHarness.store.shell(owner, (env) =>
				env.exists('/snapshots', BACKGROUND_CONTEXT),
			);
			expect(noObjects).toMatchObject({ ok: true, value: false });
		} finally {
			await storeHarness.dispose();
			await rm(root, { recursive: true, force: true });
		}
	});

	it('does not export successfully when the object owner rejects a write', async () => {
		const shell = openResource<WorkspaceEnv>({
			name: 'retention-write-failure-shell',
			backend: memoryBackend(),
		});
		const stored = new Map<string, Uint8Array>();
		let writes = 0;
		const failingBackend: ObjectBackend = {
			store: 'failing',
			connect: async () => ({
				put: async (digest, bytes) => {
					writes++;
					if (writes === 2) throw new Error('manifest object write refused');
					stored.set(digest, new Uint8Array(bytes));
				},
				get: async (digest) => stored.get(digest),
				cleanup: async () => undefined,
			}),
		};
		const objects = openResource<ObjectEnv>({
			name: 'retention-write-failure-objects',
			backend: failingBackend,
		});
		const store: SnapshotStore = {
			workspace: 'retention-write-failure',
			host: owner,
			shell: shell.use,
			objects: objects.use,
		};
		try {
			await expect(
				retainSensorObservation(
					store,
					{ name: 'observer' },
					{
						sensor: 'bench-one/bench',
						process: 'bash-444444444444',
						connection: { name: 'bench-one', owner: 'sensor-owner', port: 43130 },
						request: { api: 1 },
						source: { repository: 'test/repo', commit: 'e'.repeat(40), dirty: false },
					},
					{
						api: 1,
						observations: [
							{
								at: '2026-09-29T10:00:01.000Z',
								parts: [
									{
										kind: 'file',
										file: frameDigest,
										name: '../unsafe.png',
										mediaType: 'image/png',
									},
								],
							},
						],
					},
					new Map([[frameDigest, frameBytes]]),
				),
			).rejects.toThrow('manifest object write refused');
			expect(writes).toBe(2);
			expect(stored.get(frameDigest)).toEqual(new Uint8Array(frameBytes));
			const exports = await shell.use({ name: 'observer' }, (env) =>
				env.exists('/home/observer/sensor-observations', BACKGROUND_CONTEXT),
			);
			expect(exports).toMatchObject({ ok: true, value: false });
		} finally {
			await objects.dispose();
			await shell.dispose();
		}
	});

	it.each(['file-cancel', 'manifest-write', 'rename-cancel'] as const)(
		'removes incomplete exports after %s',
		async (failure) => {
			const controller = new AbortController();
			const disk = memoryBackend();
			const backend: BashBackend = {
				...disk,
				connect: (agent, signal) => disk.connect(agent, signal),
			};
			const shell = openResource<WorkspaceEnv>({
				name: 'retention-partial-shell',
				backend: {
					...backend,
					async connect(agent, signal) {
						const env = await backend.connect(agent, signal);
						return interruptExport(env, agent.name, failure, controller);
					},
				},
			});
			const objects = openResource<ObjectEnv>({
				name: 'retention-partial-objects',
				backend: fileObjectBackend({ shell: shell.use, host: owner, root: '/snapshots' }),
			});
			const store: SnapshotStore = {
				workspace: 'retention-partial',
				host: owner,
				shell: shell.use,
				objects: objects.use,
			};
			const bytes = new Uint8Array([1, 2, 3]);
			const digest = createHash('sha256').update(bytes).digest('hex');
			try {
				await expect(
					retainSensorObservation(
						store,
						{ name: 'observer' },
						{
							sensor: 'bench-one/bench',
							process: 'bash-555555555555',
							connection: { name: 'bench-one', owner: 'sensor-owner', port: 43131 },
							request: { api: 1 },
							source: { repository: 'test/repo', commit: 'f'.repeat(40), dirty: false },
						},
						{
							api: 1,
							observations: [
								{
									at: '2026-09-29T10:00:01.000Z',
									parts: [
										{ kind: 'file', file: digest, name: '../unsafe.csv', mediaType: 'text/csv' },
									],
								},
							],
						},
						new Map([[digest, bytes]]),
						controller.signal,
					),
				).rejects.toThrow(
					failure === 'manifest-write'
						? 'manifest export write refused'
						: failure === 'file-cancel'
							? 'Operation aborted'
							: 'cancel after rename',
				);
				const entries = await shell.use({ name: 'observer' }, (env) =>
					env.listDir('/home/observer/sensor-observations', BACKGROUND_CONTEXT),
				);
				expect(entries).toMatchObject({ ok: true, value: [] });
			} finally {
				await objects.dispose();
				await shell.dispose();
			}
		},
	);
});
