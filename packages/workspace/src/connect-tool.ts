/** The `connect` tool over a workspace sensor connection registry. */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import { SensorSourceSchema } from './sensor-api.ts';
import type { RegisteredSensorConnection, SensorConnections } from './sensor-connections.ts';
import type { DetailedResult } from './tools.ts';

const CONNECT_TOOL_NAME = 'connect';

const name = Type.String({
	pattern: '^[a-z][a-z0-9-]*(?![\\s\\S])',
	description: 'A lowercase connection name made of letters, digits, and hyphens.',
});

const connectSchema = Type.Object({
	name,
	process: Type.String({ description: 'A running process handle returned by bash.' }),
	port: Type.Integer({
		minimum: 1,
		maximum: 65535,
		description: 'The sensor server port on the workstation.',
	}),
});

type ConnectParams = Static<typeof connectSchema>;

/** The schema of the launch source of a sensor server, named for the catalog of `compose`. */
export const SensorSourceFacts = Type.Object(SensorSourceSchema.properties, {
	$id: 'SensorSource',
	additionalProperties: false,
	description: 'The repository, the commit, and the branch that the server launched from.',
});

/** The declared output of `connect`: the connection, and the sensors that it found. */
const ConnectOutput = Type.Object(
	{
		name: Type.String({ description: 'The connection name.' }),
		hostname: Type.String({ description: 'The host of the workstation.' }),
		port: Type.Integer({ description: 'The port of the sensor server.' }),
		process: Type.String({ description: 'The handle of the process that runs the server.' }),
		owner: Type.String({ description: 'The agent that owns the process.' }),
		source: SensorSourceFacts,
		sensors: Type.Array(Type.String(), {
			description: 'The qualified name of each sensor, such as bench/temperature.',
		}),
	},
	{ $id: 'ConnectResult' },
);

type ConnectDetails = Static<typeof ConnectOutput>;

/** Create the `connect` tool for a workspace that has workstation endpoints. */
export function createConnectTool(options: {
	readonly connections: SensorConnections;
}): AmbionTool {
	return defineTool({
		name: CONNECT_TOOL_NAME,
		label: 'Connect sensor server',
		description: 'Connect a running process you own to its sensor API and discover its sensors.',
		parameters: connectSchema,
		compose: { output: ConnectOutput },
		execute: async (params: ConnectParams, ctx: ToolContext) => {
			const connection = await options.connections.connect(ctx.agent, params, ctx.signal);
			return result(connection);
		},
	});
}

/** Guidance for connecting a running process to a workstation endpoint. */
export function connectToolGuidance(): string {
	return [
		`connect attaches a running process you own to a sensor server on this workstation.`,
		`Give its process handle and the server port. The server must be ready and report API version 1.`,
		`Each discovered sensor is available as <connection>/<sensor>. A repeated connect with the same`,
		`process, port, and name refreshes discovery. Only the process owner can replace an ended connection.`,
	].join('\n');
}

function result(connection: RegisteredSensorConnection): DetailedResult<ConnectDetails> {
	const sensors = connection.index.sensors.map((sensor) => `${connection.name}/${sensor.name}`);
	const source = connection.source;
	const text = [
		`Connected ${connection.name} on ${connection.hostname}:${connection.port} to process ${connection.process.handle}.`,
		`Source: ${source.repository}@${source.commit}${source.branch === undefined ? '' : ` (${source.branch})`}${source.dirty ? ' [dirty]' : ''}.`,
		sensors.length === 0
			? 'The server currently exposes no sensors.'
			: `Sensors:\n${connection.index.sensors.map((sensor) => `- ${connection.name}/${sensor.name}: ${sensor.description}`).join('\n')}`,
	].join('\n');
	return {
		content: [{ type: 'text', text }],
		details: {
			name: connection.name,
			hostname: connection.hostname,
			port: connection.port,
			process: connection.process.handle,
			owner: connection.owner,
			source,
			sensors,
		},
	};
}
