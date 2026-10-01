/**
 * A real workspace `observe` tool connected to the four-part HTTP sensor
 * fixture. Tests may invoke the tool directly or place its bundle in a room.
 */
import type { AmbionTool, ToolContext } from '@ambionframework/ambion';
import { DEFAULT_AUDIT_LOG } from '../../src/audit.ts';
import type { BashBackend, WorkspaceEndpoint, WorkspaceEndpoints } from '../../src/backend.ts';
import { openWorkspace } from '../../src/index.ts';
import type { ObjectBackend } from '../../src/object-backend.ts';
import type { Workspace } from '../../src/workspace.ts';
import { callAs, toolOf, wrapped } from './backends.ts';
import { fileBytes, fileDigest, frameBytes, frameDigest } from './sensor-blobs.ts';
import { type SensorDefect, type SensorServerOptions, startSensorServer } from './sensor-server.ts';

export interface SensorObserveRoom {
	/** Alias for consumers that name the workspace `site`. */
	readonly site: Workspace;
	readonly workspace: Workspace;
	readonly observe: AmbionTool;
	readonly owner: ToolContext;
	readonly observer: ToolContext;
	observerFor(agent: string): ToolContext;
	readonly process: string;
	readonly port: number;
	readonly origin: string;
	readonly auditPath: string;
	readonly observeCalls: number;
	stopServer(): Promise<void>;
	close(): Promise<void>;
}

/** Open a workspace, start its managed process, and connect the fixture API. */
export async function openSensorObserveRoom(
	options: {
		defect?: SensorDefect;
		server?: SensorServerOptions;
		objects?: ObjectBackend;
	} = {},
): Promise<SensorObserveRoom> {
	const server = await startSensorServer(options.defect, options.server);
	const address = new URL(server.origin);
	const port = Number(address.port);
	const endpoints: WorkspaceEndpoints = {
		machine: 'fixture-workstation',
		async forward() {
			const opened: WorkspaceEndpoint = {
				url: server.origin,
				async close() {},
			};
			return opened;
		},
	};
	const bash: BashBackend = wrapped(() => ({ endpoints }));
	const workspace = openWorkspace({
		name: `sensor-observe-${Math.random().toString(16).slice(2, 10)}`,
		backend: { bash, ...(options.objects === undefined ? {} : { objects: options.objects }) },
		audit: {},
	});
	let closed = false;
	let serverClosed = false;
	try {
		const processResult = await toolOf(workspace, 'bash').invoke(
			{ command: 'sleep 30', wait: 0 },
			callAs('sensor-owner'),
		);
		if (typeof processResult === 'string') throw new Error('The bash tool did not return details.');
		const process = (processResult.details as { process?: { handle?: string } }).process?.handle;
		if (process === undefined) throw new Error('The fixture process did not start.');
		await toolOf(workspace, 'connect').invoke(
			{ name: 'bench-one', process, port },
			callAs('sensor-owner'),
		);
		const bundle = workspace.tools();
		const observe = bundle.tools.find((tool) => tool.name === 'observe');
		if (observe === undefined) throw new Error('The workspace has no observe tool.');
		const stopServer = async () => {
			if (serverClosed) return;
			serverClosed = true;
			await server.close();
		};
		return {
			site: workspace,
			workspace,
			observe,
			process,
			port,
			origin: server.origin,
			auditPath: DEFAULT_AUDIT_LOG,
			get observeCalls() {
				return server.observeCalls;
			},
			owner: callAs('sensor-owner', { room: 'sensor-room', callId: 'connect-call' }),
			observer: callAs('observer', { room: 'sensor-room', callId: 'observe-call' }),
			observerFor(agent) {
				return callAs(agent, { room: 'sensor-room', callId: `observe-${agent}` });
			},
			stopServer,
			async close() {
				if (closed) return;
				closed = true;
				try {
					await workspace.dispose();
				} finally {
					await stopServer();
				}
			},
		};
	} catch (error) {
		await workspace.dispose().catch(() => undefined);
		await server.close().catch(() => undefined);
		throw error;
	}
}

export { fileBytes, fileDigest, frameBytes, frameDigest };
