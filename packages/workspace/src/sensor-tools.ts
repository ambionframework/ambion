/** The tools and guidance supplied when workstation ports are available. */

import type { AmbionTool } from '@ambionframework/ambion';
import type { AuditLog } from './audit.ts';
import type { WorkspaceEnv } from './backend.ts';
import { connectToolGuidance, createConnectTool } from './connect-tool.ts';
import { createObserveTool, observeToolGuidance } from './observe-tool.ts';
import type { WorkspaceResource } from './resource.ts';
import type { SensorConnections } from './sensor-connections.ts';
import type { SnapshotStore } from './snapshots.ts';

export function sensorTools(options: {
	readonly connections?: SensorConnections;
	readonly store: SnapshotStore;
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly audit?: AuditLog;
	readonly images: boolean;
}): {
	readonly names: readonly string[];
	readonly tools: readonly AmbionTool[];
	readonly notes: readonly string[];
} {
	if (options.connections === undefined) return { names: [], tools: [], notes: [] };
	return {
		names: ['connect', 'observe'],
		tools: [
			createConnectTool({
				connections: options.connections,
				shell: options.shell,
				audit: options.audit,
			}),
			createObserveTool({
				connections: options.connections,
				store: options.store,
				shell: options.shell,
				audit: options.audit,
				images: options.images,
			}),
		],
		notes: [connectToolGuidance(), observeToolGuidance(options.images)],
	};
}
