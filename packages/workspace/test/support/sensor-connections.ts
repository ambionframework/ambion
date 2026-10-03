import { createServer, type Server } from 'node:http';
import type { WorkspaceEndpoint, WorkspaceEndpoints } from '../../src/backend.ts';
import type { Process } from '../../src/process-files.ts';
import type { ProcessEvent, ProcessTable } from '../../src/process-table.ts';
import type { SensorIndex } from '../../src/sensors.ts';

export const source = {
	repository: 'tests/sensor-fixture',
	commit: 'a'.repeat(40),
	branch: 'main',
	dirty: true,
} as const;

export const index: SensorIndex = {
	api: 1,
	source,
	sensors: [{ name: 'bench', description: 'Bench fixture.', spans: false }],
};

export interface ConnectionRig {
	readonly processes: ProcessTable;
	readonly endpoints: WorkspaceEndpoints;
	readonly opens: Array<{ closed: number }>;
	readonly finds: string[];
	readonly indexRequests: number[];
	readonly status: Process;
	readonly server: Server;
	readonly url: string;
	setStatus(status: Process): void;
	failFind(error: Error): void;
	setIndex(index: unknown): void;
	blockIndex(count?: number): { entered: Promise<void>; release(): void };
	end(handle?: string, agent?: string): void;
	close(): Promise<void>;
}

export async function connectionRig(): Promise<ConnectionRig> {
	let body: unknown = index;
	const statuses = new Map<string, Process>();
	const initialStatus = status('bash-000000000001', 'owner', 'running');
	statuses.set(`${initialStatus.agent}/${initialStatus.handle}`, initialStatus);
	let nextFindError: Error | undefined;
	let blocked:
		{ entered: () => void; gate: Promise<void>; expected: number; arrived: number } | undefined;
	const listeners = new Set<(event: ProcessEvent) => void>();
	const endedKeys = new Set<string>();
	const indexRequests: number[] = [];
	const server = createServer(async (request, response) => {
		if (request.method !== 'GET' || request.url !== '/') {
			response.writeHead(404).end();
			return;
		}
		indexRequests.push(1);
		if (blocked !== undefined) {
			const barrier = blocked;
			barrier.arrived += 1;
			if (barrier.arrived === barrier.expected) barrier.entered();
			await barrier.gate;
			if (barrier.arrived === barrier.expected) blocked = undefined;
		}
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify(body));
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('HTTP fixture has no TCP port.');
	const url = `http://127.0.0.1:${address.port}`;
	const opens: Array<{ closed: number }> = [];
	const finds: string[] = [];
	const processes = {
		async find(agent: { name: string }, handle: string) {
			finds.push(`${agent.name}/${handle}`);
			if (nextFindError !== undefined) {
				const error = nextFindError;
				nextFindError = undefined;
				throw error;
			}
			const found = statuses.get(`${agent.name}/${handle}`);
			if (found === undefined)
				throw new Error(`Process '${handle}' is not owned by '${agent.name}'.`);
			return found;
		},
		ended(agent: string, handle: string) {
			return endedKeys.has(`${agent}/${handle}`);
		},
		subscribe(listener: (event: ProcessEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as ProcessTable;
	const endpoints: WorkspaceEndpoints = {
		machine: 'fixture-workstation',
		async forward() {
			const opened = { closed: 0 };
			opens.push(opened);
			return {
				url,
				async close() {
					opened.closed += 1;
				},
			} satisfies WorkspaceEndpoint;
		},
	};
	return {
		processes,
		endpoints,
		opens,
		finds,
		indexRequests,
		status: initialStatus,
		server,
		url,
		setStatus(next) {
			statuses.set(`${next.agent}/${next.handle}`, next);
		},
		failFind(error) {
			nextFindError = error;
		},
		setIndex(next) {
			body = next;
		},
		blockIndex(count = 1) {
			let enter!: () => void;
			let release!: () => void;
			const entered = new Promise<void>((resolve) => (enter = resolve));
			const gate = new Promise<void>((resolve) => (release = resolve));
			blocked = { entered: enter, gate, expected: count, arrived: 0 };
			return {
				entered,
				release() {
					release();
				},
			};
		},
		end(handle = initialStatus.handle, agent = initialStatus.agent) {
			const existing = statuses.get(`${agent}/${handle}`);
			if (existing === undefined) throw new Error(`No process '${handle}' owned by '${agent}'.`);
			const ended = {
				...existing,
				state: 'exited' as const,
				exitCode: 0,
				endedAt: new Date().toISOString(),
			};
			statuses.set(`${agent}/${handle}`, ended);
			endedKeys.add(`${agent}/${handle}`);
			for (const listener of listeners) listener({ type: 'ended', process: ended });
		},
		async close() {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		},
	};
}

export function status(handle: string, agent: string, state: Process['state']): Process {
	return {
		handle,
		kind: 'bash',
		agent,
		command: 'node server.mjs',
		port: 20000,
		state,
		output: `/home/${agent}/.processes/${handle}/out`,
		timeout: 600,
		grace: 10,
		startedAt: '2026-09-29T10:00:00.000Z',
		...(state === 'running' ? {} : { exitCode: 0, endedAt: '2026-09-29T10:00:01.000Z' }),
	};
}
