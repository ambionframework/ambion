/**
 * A real HTTP server behind a real process, for the tests of `fetch`. The
 * workspace starts `sleep` through `bash` and reports its port. The test
 * serves its routes on that port, so the endpoints of the backend reach the
 * server through the port of the process.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { ToolContext } from '@ambionframework/ambion';
import type { BashBackend, WorkspaceEndpoints } from '../../src/backend.ts';
import type { Process } from '../../src/process-files.ts';
import { openWorkspace, type Workspace } from '../../src/workspace.ts';
import { callAs, toolOf, wrapped } from './backends.ts';

/** One forward that the endpoints opened. */
export interface ForwardRecord {
	readonly agent: string;
	readonly port: number;
	closed: boolean;
}

/**
 * The endpoints of the test backend. A forward points at `127.0.0.1` on the
 * port that it is given, and records its agent and its close. `fail` makes
 * the next forwards throw, one for each entry.
 */
export function httpEndpoints(
	records: ForwardRecord[] = [],
	fail: Error[] = [],
): WorkspaceEndpoints {
	return {
		machine: 'test',
		forward: async (agent, port) => {
			const failure = fail.shift();
			if (failure !== undefined) throw failure;
			const record: ForwardRecord = { agent: agent.name, port, closed: false };
			records.push(record);
			return {
				url: `http://127.0.0.1:${port}`,
				close: async () => {
					record.closed = true;
				},
			};
		},
	};
}

/** The memory backend of `wrapped`, with the endpoints of the fixture. */
export const httpBackend = (records: ForwardRecord[] = []): BashBackend =>
	wrapped(() => ({ endpoints: httpEndpoints(records) }));

let serial = 0;

/** A workspace over `httpBackend`, and the forwards that its endpoints opened. */
export function httpWorkspace(): { workspace: Workspace; forwards: ForwardRecord[] } {
	serial += 1;
	const forwards: ForwardRecord[] = [];
	const workspace = openWorkspace({
		name: `http-${serial}`,
		backend: { bash: httpBackend(forwards) },
	});
	return { workspace, forwards };
}

/** Start `sleep` through `bash` with `name`, as `agent`, and give the process and its port. */
export async function mapped(
	workspace: Workspace,
	agent: string,
	name: string,
	context: Partial<ToolContext> = {},
): Promise<{ process: Process; port: number }> {
	const result = await toolOf(workspace, 'bash').invoke(
		{ command: 'sleep 300', name, wait: 0 },
		callAs(agent, context),
	);
	if (typeof result === 'string') throw new Error('bash gives a structured result.');
	const { process } = result.details as { process: Process };
	return { process, port: process.port };
}

/** One answer of a route. */
export interface Reply {
	readonly status?: number;
	readonly type?: string;
	readonly body: string | Uint8Array;
	/** A function that runs before the reply, so a test can end the process first. */
	readonly before?: () => Promise<void>;
}

/** The routes of a server, by path with its query. A path that no route names answers 404. */
export type Routes = Readonly<Record<string, Reply | (() => Reply | Promise<Reply>)>>;

/** A server that listens on `port` of the loopback. */
export interface Served {
	/** The paths that the server answered, in order. */
	readonly requests: string[];
	close(): Promise<void>;
}

async function answer(routes: Routes, request: IncomingMessage, response: ServerResponse) {
	const route = routes[request.url ?? ''];
	if (route === undefined) {
		response.writeHead(404, { 'content-type': 'text/plain' }).end('not here');
		return;
	}
	const reply = typeof route === 'function' ? await route() : route;
	await reply.before?.();
	const headers = reply.type === undefined ? {} : { 'content-type': reply.type };
	response.writeHead(reply.status ?? 200, headers).end(reply.body);
}

/** Serve `routes` on `port`. A listener that holds the port fails the test. */
export async function serve(routes: Routes, port: number): Promise<Served> {
	const requests: string[] = [];
	const server = createServer((request, response) => {
		requests.push(request.url ?? '');
		void answer(routes, request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => resolve());
	});
	return {
		requests,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
