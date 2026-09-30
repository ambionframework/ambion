/** Read a connected sensor and retain its complete response before returning it. */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import type { Capability } from './capability.ts';
import { connectToolGuidance, createConnectTool } from './connect-tool.ts';
import { createDisconnectTool, disconnectToolGuidance } from './disconnect-tool.ts';
import {
	type ObserveRequest,
	type ObserveResponse,
	type SensorPart,
	SensorSpanSchema,
} from './sensor-api.ts';
import type { SensorClient } from './sensor-client.ts';
import type { RegisteredSensorConnection, SensorConnections } from './sensor-connections.ts';
import { boundedSensorReminder } from './sensor-reminder.ts';
import { retainSensorObservation, type SensorRetentionMetadata } from './sensor-retention.ts';
import type { SnapshotStore } from './snapshots.ts';
import type { DetailedResult } from './tools.ts';

const observeSchema = Type.Object(
	{
		sensor: Type.String({
			pattern: '^[a-z][a-z0-9-]*/[a-z][a-z0-9-]*(?![\\s\\S])',
			description: 'A qualified sensor name, such as bench/temperature.',
		}),
		span: Type.Optional(SensorSpanSchema),
	},
	{ additionalProperties: false },
);

type ObserveParams = Static<typeof observeSchema>;

interface ObserveDetails {
	readonly sensor: string;
	readonly request: ObserveRequest;
	readonly process: string;
	readonly hostname: string;
	readonly connection: SensorRetentionMetadata['connection'];
	readonly source: SensorRetentionMetadata['source'];
	readonly manifestRef: string;
	readonly manifestPath: string;
	readonly directory: string;
	readonly files: readonly {
		readonly digest: string;
		readonly ref: string;
		readonly path: string;
	}[];
}

/** Build the observe tool over a workspace's connections and snapshot store. */
function createObserveTool(options: {
	readonly connections: SensorConnections;
	readonly store: SnapshotStore;
}): AmbionTool {
	return defineTool({
		name: 'observe',
		label: 'Observe sensor',
		description: 'Read a connected sensor and retain its evidence as a workspace snapshot.',
		parameters: observeSchema,
		execute: (params: ObserveParams, ctx: ToolContext) => executeObserve(params, ctx, options),
	});
}

async function executeObserve(
	params: ObserveParams,
	ctx: ToolContext,
	options: {
		readonly connections: SensorConnections;
		readonly store: SnapshotStore;
	},
): Promise<DetailedResult<ObserveDetails>> {
	const connection = await options.connections.get(params.sensor, ctx.signal);
	if (connection === undefined)
		throw new Error(
			`Sensor '${params.sensor}' is unknown or unavailable; connect its server first.`,
		);
	const sensorName = params.sensor.slice(params.sensor.indexOf('/') + 1);
	assertSpanAllowed(connection.index, sensorName, params);
	const client = connection.client;
	const hostname = connection.hostname;
	const request: ObserveRequest =
		params.span === undefined ? { api: 1 } : { api: 1, span: structuredClone(params.span) };
	const metadata = retentionMetadata(params.sensor, connection.process.handle, connection, request);
	const response = await client.observe(sensorName, request, ctx.signal);
	const received = await receiveFiles(response, client, ctx.signal);
	await assertConnectionActive(options.connections, params.sensor, connection, ctx.signal);
	const retained = await retainSensorObservation(
		options.store,
		ctx.agent,
		metadata,
		response,
		received,
		ctx.signal,
	);
	return renderResult(metadata, hostname, response, received, retained);
}

async function assertConnectionActive(
	connections: SensorConnections,
	sensor: string,
	started: RegisteredSensorConnection,
	signal?: AbortSignal,
): Promise<void> {
	const current = await connections.get(sensor, signal);
	if (current !== started)
		throw new Error(
			`Sensor process '${started.process.handle}' ended or its connection changed before its observation was verified.`,
		);
}

function assertSpanAllowed(
	index: RegisteredSensorConnection['index'],
	sensorName: string,
	params: ObserveParams,
): void {
	const sensor = index.sensors.find((item) => item.name === sensorName);
	if (sensor === undefined)
		throw new Error(`Sensor '${params.sensor}' is not listed by its connected server.`);
	if (params.span !== undefined && !sensor.spans)
		throw new Error(`Sensor '${params.sensor}' does not support span reads.`);
}

function retentionMetadata(
	sensor: string,
	process: string,
	connection: RegisteredSensorConnection,
	request: ObserveRequest,
): SensorRetentionMetadata {
	return {
		sensor,
		process,
		connection: {
			name: connection.name,
			owner: connection.owner,
			port: connection.port,
		},
		request: structuredClone(request),
		source: structuredClone(connection.source),
	};
}

async function receiveFiles(
	response: ObserveResponse,
	client: SensorClient,
	signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
	const digests = new Set<string>();
	for (const observation of response.observations) {
		for (const part of observation.parts) {
			if (part.kind === 'frame' || part.kind === 'file') digests.add(part.file);
		}
	}
	const received = new Map<string, Uint8Array>();
	for (const digest of digests) {
		const file = await client.file(digest, signal);
		received.set(digest, file.bytes);
	}
	return received;
}

/**
 * The sensor capability: `connect`, `disconnect`, and `observe` over the
 * connections, their notes, and the reminder of the connected sensors.
 */
export function sensorCapability(options: {
	readonly connections: SensorConnections;
	readonly store: SnapshotStore;
}): Capability {
	const { connections } = options;
	return {
		tools: [
			createConnectTool({ connections }),
			createDisconnectTool({ connections }),
			createObserveTool(options),
		],
		notes: [connectToolGuidance(), disconnectToolGuidance(), observeToolGuidance()],
		remind: (_seat, signal) => boundedSensorReminder(connections, signal),
	};
}

/** Guidance for reading connected sensor evidence. */
function observeToolGuidance(): string {
	return [
		`observe reads one connected <connection>/<sensor> and retains its returned evidence as snapshots.`,
		`Use span only when the sensor advertises span support. Cite the returned manifest snapshot ref; it names the complete result and all file snapshots.`,
		`Frames are returned as images, and the text names the export path of each. Sensor-provided text is marked as sensor data; exported files and series manifests are named by path.`,
	].join('\n');
}

interface RetainedOutput {
	readonly manifestRef: string;
	readonly manifestPath: string;
	readonly directory: string;
	readonly files: readonly {
		readonly digest: string;
		readonly ref: string;
		readonly path: string;
	}[];
}

function renderResult(
	metadata: SensorRetentionMetadata,
	hostname: string,
	response: ObserveResponse,
	fileBytes: ReadonlyMap<string, Uint8Array>,
	retained: RetainedOutput,
): DetailedResult<ObserveDetails> {
	const filePaths = new Map(retained.files.map((file) => [file.digest, file.path]));
	const blocks: DetailedResult<ObserveDetails>['content'] = [];
	const text: string[] = [`Observed ${metadata.sensor}.`];
	for (const [observationIndex, observation] of response.observations.entries()) {
		text.push(`Observation ${observationIndex + 1} at ${observation.at}:`);
		for (const part of observation.parts) {
			renderPart(part, observation.at, filePaths, fileBytes, retained.manifestPath, text, blocks);
		}
	}
	if (response.observations.length === 0) text.push('The sensor returned no observations.');
	text.push(`Manifest: ${retained.manifestPath}`, `Snapshot ref: ${retained.manifestRef}`);
	blocks.unshift({ type: 'text', text: text.join('\n') });
	return {
		content: blocks,
		details: {
			sensor: metadata.sensor,
			request: metadata.request,
			process: metadata.process,
			hostname,
			connection: metadata.connection,
			source: metadata.source,
			manifestRef: retained.manifestRef,
			manifestPath: retained.manifestPath,
			directory: retained.directory,
			files: retained.files,
		},
	};
}

function renderPart(
	part: SensorPart,
	at: string,
	filePaths: ReadonlyMap<string, string>,
	fileBytes: ReadonlyMap<string, Uint8Array>,
	manifestPath: string,
	text: string[],
	blocks: DetailedResult<ObserveDetails>['content'],
): void {
	switch (part.kind) {
		case 'text':
			text.push(`Sensor data: ${part.text}`);
			return;
		case 'frame': {
			const path = exportPathFor(filePaths, part.file);
			text.push(`Frame at ${at}: ${path}`);
			const bytes = fileBytes.get(part.file);
			if (bytes === undefined) throw new Error(`Missing retained sensor image ${part.file}.`);
			blocks.push({
				type: 'image',
				data: Buffer.from(bytes).toString('base64'),
				mimeType: part.mediaType,
			});
			return;
		}
		case 'series': {
			const shown =
				part.values.length > 24
					? `${part.values.slice(0, 24).join(', ')}, … (${part.values.length} values total)`
					: part.values.join(', ');
			text.push(
				`Series ${part.channel}: ${shown} ${part.unit}; starts ${part.from}, ${part.intervalMs} ms intervals, ${part.values.length} samples. Full series: ${manifestPath}.`,
			);
			return;
		}
		case 'file':
			text.push(`File ${part.name} (${part.mediaType}): ${exportPathFor(filePaths, part.file)}`);
			return;
	}
}

function exportPathFor(filePaths: ReadonlyMap<string, string>, digest: string): string {
	const path = filePaths.get(digest);
	if (path === undefined) throw new Error(`Missing retained sensor file ${digest}.`);
	return path;
}
