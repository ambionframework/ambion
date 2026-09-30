/** Detach a sensor link; process lifetime remains the responsibility of cancel. */
import { type AmbionTool, defineTool } from '@ambionframework/ambion';
import { Type } from 'typebox';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import type { WorkspaceResource } from './resource.ts';
import type { SensorConnections } from './sensor-connections.ts';
import { recordedOnShell } from './tools.ts';

export function createDisconnectTool(options: {
	readonly connections: SensorConnections;
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly audit?: AuditLog;
}): AmbionTool {
	return defineTool({
		name: 'disconnect',
		label: 'Disconnect sensor server',
		description:
			'Detach a sensor connection you own. Its process keeps running; use cancel to stop it.',
		parameters: Type.Object(
			{ name: Type.String({ pattern: '^[a-z][a-z0-9-]*(?![\\s\\S])' }) },
			{ additionalProperties: false },
		),
		execute: recordedOnShell(
			'disconnect',
			options.shell,
			options.audit,
			async (params: { name: string }, ctx) => {
				await options.connections.disconnect(ctx.agent, params.name, ctx.signal);
				return {
					content: [
						{ type: 'text', text: `Disconnected ${params.name}. Its process was not stopped.` },
					],
					details: { name: params.name },
				};
			},
		),
	});
}
export function disconnectToolGuidance(): string {
	return 'disconnect({ name }) detaches a sensor link you own without stopping its process. Use cancel to stop the server. Reconnect a running server with connect; disconnected names remain reserved to their owner.';
}
