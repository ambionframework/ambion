/** The tools and guidance supplied when workstation ports are available. */

import type { AmbionTool } from '@ambionframework/ambion';
import { connectToolGuidance, createConnectTool } from './connect-tool.ts';
import { createObserveTool, observeToolGuidance } from './observe-tool.ts';
import type { SensorConnections } from './sensor-connections.ts';
import type { SnapshotStore } from './snapshots.ts';

export function sensorTools(options: {
	readonly connections?: SensorConnections;
	readonly store: SnapshotStore;
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
			createConnectTool({ connections: options.connections }),
			createObserveTool({
				connections: options.connections,
				store: options.store,
				images: options.images,
			}),
		],
		notes: [connectToolGuidance(), observeToolGuidance(options.images)],
	};
}
