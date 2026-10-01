/** Internal automatic retention for already validated sensor observations. */

import { posix } from 'node:path';
import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { Check } from 'typebox/value';
import { randomName } from './execution-env.ts';
import { contextOf, unwrap } from './object-files.ts';
import { sha256Hex } from './object-rules.ts';
import { isHandle } from './process-files.ts';
import type { WorkspaceAgent } from './resource.ts';
import { SensorDigestError } from './sensor-client.ts';
import type { ObserveRequest, ObserveResponse, SensorSource } from './sensors.ts';
import { isValidObserveRequest, ObserveResponseSchema, SensorSourceSchema } from './sensors.ts';
import type { SnapshotStore } from './snapshots.ts';
import { retainSnapshotBuffer } from './snapshots.ts';

/** Connection facts captured at successful connect time. */
interface SensorRetentionConnection {
	readonly name: string;
	readonly owner: string;
	readonly port: number;
}

/** Facts captured when the connected process was validated by its owner. */
export interface SensorRetentionMetadata {
	readonly sensor: string;
	readonly process: string;
	readonly connection: SensorRetentionConnection;
	readonly request: ObserveRequest;
	readonly source: SensorSource;
}

/** The portable manifest stored as a regular snapshot object. */
interface SensorObservationManifest {
	readonly api: 1;
	readonly sensor: string;
	readonly process: string;
	readonly connection: SensorRetentionConnection;
	readonly request: ObserveRequest;
	readonly source: SensorSource;
	readonly observations: ObserveResponse['observations'];
	readonly files: readonly { readonly digest: string; readonly ref: string }[];
}

/** The completed local export and the snapshot refs that retain its contents. */
export interface RetainedSensorObservation {
	readonly manifest: SensorObservationManifest;
	readonly manifestRef: string;
	readonly directory: string;
	readonly manifestPath: string;
	readonly files: readonly {
		readonly digest: string;
		readonly ref: string;
		readonly path: string;
	}[];
}

interface ReceivedFile {
	readonly digest: string;
	readonly bytes: Uint8Array;
}

interface CapturedInput {
	readonly metadata: SensorRetentionMetadata;
	readonly response: ObserveResponse;
	readonly files: readonly ReceivedFile[];
}

function validateMetadata(metadata: SensorRetentionMetadata): void {
	if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(metadata.sensor))
		throw new Error(`Invalid qualified sensor name: ${JSON.stringify(metadata.sensor)}.`);
	if (metadata.sensor.split('/', 1)[0] !== metadata.connection.name)
		throw new Error('The qualified sensor name does not match the captured connection.');
	if (!/^[a-z][a-z0-9-]*$/.test(metadata.connection.name))
		throw new Error('The captured connection name is invalid.');
	if (!isHandle(metadata.process))
		throw new Error('The captured sensor process handle is invalid.');
	if (!isValidObserveRequest(metadata.request))
		throw new Error('The retained request fails the sensor API version 1 schema.');
	if (
		!metadata.connection.name ||
		!metadata.connection.owner ||
		!Number.isInteger(metadata.connection.port) ||
		metadata.connection.port < 1 ||
		metadata.connection.port > 65535
	)
		throw new Error('The captured sensor connection metadata is invalid.');
	if (!Check(SensorSourceSchema, metadata.source))
		throw new Error('The captured launch source fails the sensor API version 1 schema.');
}

function fileDigests(observations: ObserveResponse['observations']): Set<string> {
	const digests = new Set<string>();
	for (const observation of observations) {
		for (const part of observation.parts) {
			if (part.kind === 'frame' || part.kind === 'file') digests.add(part.file);
		}
	}
	return digests;
}

function write(
	env: ExecutionEnv,
	path: string,
	bytes: Uint8Array,
	context: Context,
): Promise<void> {
	return env.writeFile(path, bytes, context).then((result) => {
		unwrap(result, `Cannot export ${path}`);
	});
}

function captureInput(
	metadataInput: SensorRetentionMetadata,
	responseInput: ObserveResponse,
	receivedInput: ReadonlyMap<string, Uint8Array>,
): CapturedInput {
	const metadata: SensorRetentionMetadata = {
		sensor: metadataInput.sensor,
		process: metadataInput.process,
		connection: structuredClone(metadataInput.connection),
		request: structuredClone(metadataInput.request),
		source: structuredClone(metadataInput.source),
	};
	const response = structuredClone(responseInput);
	const files = [...receivedInput].map(([digest, bytes]) => ({
		digest,
		bytes: new Uint8Array(bytes),
	}));
	validateMetadata(metadata);
	if (!Check(ObserveResponseSchema, response))
		throw new Error('The retained response fails the sensor API version 1 schema.');
	verifyReceived(response, files);
	return { metadata, response, files };
}

function verifyReceived(response: ObserveResponse, files: readonly ReceivedFile[]): void {
	const needed = fileDigests(response.observations);
	const byDigest = new Map(files.map((file) => [file.digest, file]));
	for (const digest of needed) {
		const file = byDigest.get(digest);
		if (!file)
			throw new Error(
				`The observation references file ${digest}, but its bytes were not received.`,
			);
		const actual = sha256Hex(file.bytes);
		if (actual !== digest) throw new SensorDigestError(digest, actual);
	}
	for (const file of files) {
		if (!/^[0-9a-f]{64}$/.test(file.digest))
			throw new Error(`Invalid sensor file digest: ${file.digest}.`);
		if (!needed.has(file.digest))
			throw new Error(`Received file ${file.digest} is not referenced by the observation.`);
	}
}

async function storeFiles(
	store: SnapshotStore,
	files: readonly (ReceivedFile & { readonly name: string; readonly refPath: string })[],
	signal?: AbortSignal,
): Promise<{ readonly digest: string; readonly ref: string; readonly path: string }[]> {
	const retained: { digest: string; ref: string; path: string }[] = [];
	for (const file of files) {
		const saved = await retainSnapshotBuffer(store, file.refPath, file.bytes, signal);
		retained.push({
			digest: saved.digest,
			ref: saved.ref,
			path: posix.join(posix.dirname(file.refPath), file.name),
		});
	}
	return retained;
}

async function publishExport(
	store: SnapshotStore,
	observer: WorkspaceAgent,
	paths: { readonly directory: string; readonly staging: string },
	files: readonly (ReceivedFile & { readonly name: string })[],
	manifestBytes: Uint8Array,
	signal: AbortSignal | undefined,
	context: Context,
): Promise<void> {
	try {
		await store.bash(
			observer,
			async (env) => {
				unwrap(
					await env.createDir(paths.staging, { recursive: true }, context),
					`Cannot create ${paths.staging}`,
				);
				for (const file of files)
					await write(env, posix.join(paths.staging, file.name), file.bytes, context);
				// The manifest is the completion marker and is written after all files.
				await write(env, posix.join(paths.staging, 'manifest.json'), manifestBytes, context);
				if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
				unwrap(
					await env.renameFile(paths.staging, paths.directory, context),
					`Cannot publish ${paths.directory}`,
				);
			},
			signal,
		);
		if (signal?.aborted) throw signal.reason ?? new Error('Operation aborted.');
	} catch (error) {
		await store
			.bash(
				observer,
				async (env) => {
					for (const path of [paths.staging, paths.directory])
						await env.remove(path, { recursive: true, force: true }, contextOf(undefined));
				},
				undefined,
			)
			.catch(() => undefined);
		throw error;
	}
}

/**
 * Keep a verified observation in the workspace object store, then publish a
 * complete export into the observing agent's home. No object operation
 * runs from inside the callback of the bash resource.
 */
export async function retainSensorObservation(
	store: SnapshotStore,
	observer: WorkspaceAgent,
	metadataInput: SensorRetentionMetadata,
	responseInput: ObserveResponse,
	receivedInput: ReadonlyMap<string, Uint8Array>,
	signal?: AbortSignal,
): Promise<RetainedSensorObservation> {
	// Take ownership synchronously: callers may reuse or mutate their buffers as
	// soon as this function returns its promise.
	const {
		metadata,
		response,
		files: received,
	} = captureInput(metadataInput, responseInput, receivedInput);

	const id = randomName();
	const rootPath = `~/sensor-observations/${id}`;
	const stagePath = `~/sensor-observations/.${id}.part`;
	const context = contextOf(signal);
	const paths = await store.bash(
		observer,
		async (env) => {
			const directory = unwrap(
				await env.absolutePath(rootPath, context),
				'Cannot resolve the sensor export directory',
			);
			const staging = unwrap(
				await env.absolutePath(stagePath, context),
				'Cannot resolve the sensor staging directory',
			);
			return { directory, staging };
		},
		signal,
	);

	const exportFiles = received.map((file, index) => ({
		...file,
		name: `file-${String(index + 1).padStart(3, '0')}.bin`,
		refPath: posix.join(paths.directory, `file-${String(index + 1).padStart(3, '0')}.bin`),
	}));
	const retainedFiles = await storeFiles(store, exportFiles, signal);

	const manifest: SensorObservationManifest = {
		api: 1,
		sensor: metadata.sensor,
		process: metadata.process,
		connection: metadata.connection,
		request: metadata.request,
		source: metadata.source,
		observations: response.observations,
		files: retainedFiles.map(({ digest, ref }) => ({ digest, ref })),
	};
	const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
	const manifestPath = posix.join(paths.directory, 'manifest.json');
	const savedManifest = await retainSnapshotBuffer(store, manifestPath, manifestBytes, signal);
	const manifestRef = savedManifest.ref;

	await publishExport(store, observer, paths, exportFiles, manifestBytes, signal, context);

	return {
		manifest,
		manifestRef,
		directory: paths.directory,
		manifestPath,
		files: retainedFiles,
	};
}
