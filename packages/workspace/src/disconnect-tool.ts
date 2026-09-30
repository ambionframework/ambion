/** The `disconnect` tool over a workspace sensor connection registry. */

import { type AmbionTool, defineTool, type ToolContext } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import type { SensorConnections } from './sensor-connections.ts';

const disconnectSchema = Type.Object(
	{ name: Type.String({ pattern: '^[a-z][a-z0-9-]*(?![\\s\\S])' }) },
	{ additionalProperties: false },
);

type DisconnectParams = Static<typeof disconnectSchema>;

/** Create the `disconnect` tool. It detaches a connection and leaves its process running. */
export function createDisconnectTool(options: {
	readonly connections: SensorConnections;
}): AmbionTool {
	return defineTool({
		name: 'disconnect',
		label: 'Disconnect sensor server',
		description:
			'Detach a sensor connection you own. Its process keeps running; use cancel to stop it.',
		parameters: disconnectSchema,
		execute: async (params: DisconnectParams, ctx: ToolContext) => {
			await options.connections.disconnect(ctx.agent, params.name, ctx.signal);
			return {
				content: [
					{ type: 'text', text: `Disconnected ${params.name}. Its process was not stopped.` },
				],
				details: { name: params.name },
			};
		},
	});
}

/** Guidance for detaching a connection. */
export function disconnectToolGuidance(): string {
	return 'disconnect({ name }) detaches a sensor connection you own without stopping its process. Use cancel to stop the server. Reconnect a running server with connect. A disconnected name stays reserved to its owner.';
}
