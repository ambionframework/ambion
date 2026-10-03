/**
 * The forward cache of `fetch`: one function for the tool and the host. It
 * finds a running process of the workspace by name or handle, and sends a
 * request to the port of that process through the endpoints of the bash
 * backend. It keeps one forward for each process, and closes it when the
 * process ends.
 *
 * `docs/processes.md` is the design contract.
 */

import type { WorkspaceEndpoint, WorkspaceEndpoints } from './backend.ts';
import { isHandle, type Process } from './process-files.ts';
import type { ProcessTable } from './process-table.ts';

/** What the tool and the host use to read a process. */
export interface ProcessFetch {
	/** Resolve a name or handle to one running process of the workspace. */
	resolve(process: string, signal?: AbortSignal): Promise<Process>;
	/** Send a request to the port of a resolved process. */
	send(process: Process, path: string, init?: RequestInit): Promise<Response>;
	/** Close every forward. Later calls of `send` fail. */
	close(): Promise<void>;
}

/** One forward: its opening, and the controller that stops an opening that has not ended. */
interface Forward {
	readonly open: Promise<WorkspaceEndpoint>;
	readonly controller: AbortController;
}

const CLOSED = 'Workspace is no longer available.';

/** The root URL of an endpoint, with no slash at its end. */
const rootOf = (endpoint: WorkspaceEndpoint): string => endpoint.url.replace(/\/+$/, '');

/** Wait for `promise`, or reject when `signal` aborts first. */
function until<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) return Promise.reject(signal.reason ?? new Error('Operation aborted.'));
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error('Operation aborted.'));
		signal.addEventListener('abort', abort, { once: true });
		const done = () => signal.removeEventListener('abort', abort);
		promise.then(
			(value) => {
				done();
				resolve(value);
			},
			(error: unknown) => {
				done();
				reject(error);
			},
		);
	});
}

/** The text that names the processes of a refused name: `<handle> of <agent>`, in order. */
const named = (found: readonly Process[]): string =>
	found.map((one) => `${one.handle} of ${one.agent}`).join(', ');

/**
 * Open the forward cache over the process table and the endpoints of the
 * bash backend. `processes.hostList` covers the agents that used the
 * workspace in this run of the host.
 */
export function createProcessFetch(options: {
	readonly processes: ProcessTable;
	readonly endpoints: WorkspaceEndpoints;
}): ProcessFetch {
	const { processes, endpoints } = options;
	const forwards = new Map<string, Forward>();
	let closing: Promise<void> | undefined;

	const discard = async (handle: string): Promise<void> => {
		const forward = forwards.get(handle);
		if (forward === undefined) return;
		forwards.delete(handle);
		forward.controller.abort(new Error('The forward closed.'));
		await forward.open.then(
			(endpoint) => endpoint.close(),
			() => undefined,
		);
	};

	const unsubscribe = processes.subscribe((event) => {
		if (event.type === 'ended') void discard(event.process.handle);
	});

	/** The forward of `process`. A forward that fails is not kept, so the next call opens it again. */
	const forwardOf = (process: Process): Forward => {
		const kept = forwards.get(process.handle);
		if (kept !== undefined) return kept;
		const controller = new AbortController();
		const open = endpoints.forward({ name: process.agent }, process.port, controller.signal);
		const forward: Forward = { open, controller };
		forwards.set(process.handle, forward);
		open.catch(() => {
			if (forwards.get(process.handle) === forward) forwards.delete(process.handle);
		});
		return forward;
	};

	const resolve: ProcessFetch['resolve'] = async (process, signal) => {
		signal?.throwIfAborted();
		const running = await processes.hostList({ running: true });
		const found = running.filter((one) =>
			isHandle(process) ? one.handle === process : one.name === process,
		);
		const [only, ...more] = found;
		if (only === undefined) {
			throw new Error(
				`No running process is named '${process}'. A process of an agent that has not acted since the host started is not listed yet.`,
			);
		}
		if (more.length > 0) {
			throw new Error(
				`Two running processes are named '${process}': ${named(found)}. Give the handle.`,
			);
		}
		return only;
	};

	const send: ProcessFetch['send'] = async (process, path, init = {}) => {
		if (closing !== undefined) throw new Error(CLOSED);
		if (process.port < 1) throw new Error(`Process ${process.handle} has no port.`);
		if (!path.startsWith('/')) throw new Error(`The path ${path} does not start with a slash.`);
		const endpoint = await until(forwardOf(process).open, init.signal ?? undefined);
		// A process that ended while its forward opened keeps no forward.
		if (processes.ended(process.agent, process.handle)) {
			await discard(process.handle);
			throw new Error(`Process ${process.handle} ended.`);
		}
		// The path joins the root as text, so a path such as //host/x stays on the forward.
		return fetch(`${rootOf(endpoint)}${path}`, { ...init, redirect: 'error' });
	};

	const close = (): Promise<void> => {
		closing ??= (async () => {
			unsubscribe();
			await Promise.allSettled([...forwards.keys()].map(discard));
		})();
		return closing;
	};

	return { resolve, send, close };
}
