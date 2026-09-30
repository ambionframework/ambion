/** The one-host-run registry for sensor processes connected to a workspace. */

import type { WorkspacePort, WorkspacePorts } from './backend.ts';
import type { ProcessStatus } from './process-files.ts';
import type { ProcessEvent, ProcessTable } from './process-table.ts';
import type { WorkspaceAgent } from './resource.ts';
import { createSensorClient, type SensorClient } from './sensor-client.ts';
import {
	belongsToEnded,
	discovery,
	freezeIndex,
	freezeSource,
	sameIdentity,
	sameSource,
	validateIndex,
} from './sensor-connection-facts.ts';
import type { SensorIndex, SensorSource } from './sensors.ts';

/** The validated connection facts available to workspace sensor readers. */
export interface RegisteredSensorConnection {
	readonly name: string;
	readonly owner: string;
	readonly process: ProcessStatus;
	readonly port: number;
	readonly hostname: string;
	readonly source: SensorSource;
	readonly index: SensorIndex;
	readonly client: SensorClient;
	readonly available: boolean;
}

/** The display-safe sensor discovery for one connection. */
export interface SensorDiscovery {
	readonly name: string;
	readonly hostname: string;
	readonly port: number;
	readonly process: string;
	readonly state: 'connected' | 'unavailable' | 'disconnected' | 'unknown';
	readonly sensors: SensorIndex['sensors'];
}

/** A committed link change. Listener failures cannot undo a registry change. */
export interface SensorConnectionEvent {
	readonly type: 'connected' | 'refreshed' | 'disconnected' | 'unavailable';
	readonly connection: SensorDiscovery;
}

/** The registry shared by standard tools and the host's sensor widgets. */
export interface SensorConnections {
	connect(
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		signal?: AbortSignal,
	): Promise<RegisteredSensorConnection>;
	/** Detach an owned link without stopping its process. Repeated calls are harmless. */
	disconnect(agent: WorkspaceAgent, name: string, signal?: AbortSignal): Promise<void>;
	/** Subscribe to committed link changes. Returns an unsubscribe function. */
	subscribe(listener: (event: SensorConnectionEvent) => void): () => void;
	/** Look up a qualified name after rechecking its owning process. */
	get(sensor: string, signal?: AbortSignal): Promise<RegisteredSensorConnection | undefined>;
	/** List captured discovery and process state without reading a server. */
	list(signal?: AbortSignal): Promise<readonly SensorDiscovery[]>;
	/** Abort connection work and close every registered transport. */
	close(): Promise<void>;
}

interface MutableConnection extends RegisteredSensorConnection {
	index: SensorIndex;
	process: ProcessStatus;
	client: SensorClient;
	available: boolean;
	transport: WorkspacePort;
	detached?: boolean;
}

interface Attempt {
	readonly name: string;
	readonly owner: string;
	readonly controller: AbortController;
	readonly promise: Promise<unknown>;
}

/** Open the in-memory registry over the process table and optional port transport. */
export function createSensorConnections(
	ports: WorkspacePorts,
	processes: ProcessTable,
): SensorConnections {
	const byName = new Map<string, MutableConnection>();
	const attempts = new Set<Attempt>();
	const transports = new Set<WorkspacePort>();
	const closeInFlight = new WeakMap<WorkspacePort, Promise<void>>();
	const endedProcesses = new Set<string>();
	const listeners = new Set<(event: SensorConnectionEvent) => void>();
	let closing: Promise<void> | undefined;
	const processKey = (owner: string, handle: string): string => `${owner}\0${handle}`;

	const notify = (type: SensorConnectionEvent['type'], connection: MutableConnection) => {
		const event = Object.freeze({
			type,
			connection: discovery(
				connection,
				connection.detached ? 'disconnected' : connection.available ? 'connected' : 'unavailable',
			),
		});
		for (const listener of listeners) {
			try {
				listener(event);
			} catch {
				/* Host widgets cannot change a committed link. */
			}
		}
	};

	const closeTransport = (transport: WorkspacePort): Promise<void> => {
		const pending = closeInFlight.get(transport);
		if (pending !== undefined) return pending;
		const closingTransport = transport.close().then(
			() => {
				transports.delete(transport);
			},
			(error: unknown) => {
				closeInFlight.delete(transport);
				throw error;
			},
		);
		closeInFlight.set(transport, closingTransport);
		return closingTransport;
	};
	const disposeTransport = (connection: MutableConnection): Promise<void> => {
		return closeTransport(connection.transport);
	};
	const refresh = async (
		connection: MutableConnection,
		process: ProcessStatus,
		index: SensorIndex,
		transport: WorkspacePort,
	): Promise<RegisteredSensorConnection> => {
		const type = connection.detached ? 'connected' : 'refreshed';
		const oldTransport = connection.transport;
		connection.transport = transport;
		connection.client = createSensorClient(transport.url);
		connection.index = freezeIndex(index, connection.source);
		connection.process = process;
		connection.available = true;
		connection.detached = false;
		notify(type, connection);
		try {
			await closeTransport(oldTransport);
		} catch {
			// Keep the old transport tracked so workspace disposal can retry its cleanup.
		}
		return connection;
	};

	const ended = (event: ProcessEvent): void => {
		if (event.type !== 'ended') return;
		endedProcesses.add(processKey(event.process.agent, event.process.handle));
		for (const connection of byName.values()) {
			if (!belongsToEnded(connection, event.process)) continue;
			connection.available = false;
			notify('unavailable', connection);
			void disposeTransport(connection).catch(() => undefined);
		}
	};
	const unsubscribe = processes.subscribe(ended);

	const markEnded = (connection: MutableConnection, status?: ProcessStatus): void => {
		if (status !== undefined) connection.process = status;
		endedProcesses.add(processKey(connection.owner, connection.process.handle));
		if (!connection.available) return;
		connection.available = false;
		notify('unavailable', connection);
		void disposeTransport(connection).catch(() => undefined);
	};

	const assertRunning = async (
		agent: WorkspaceAgent,
		handle: string,
		signal?: AbortSignal,
	): Promise<ProcessStatus> => {
		if (endedProcesses.has(processKey(agent.name, handle)))
			throw new Error(`Process '${handle}' has ended and cannot be connected again.`);
		const status = await processes.find(agent, handle, signal);
		if (status.agent !== agent.name || status.handle !== handle)
			throw new Error(`Process '${handle}' is not owned by '${agent.name}'.`);
		if (status.state !== 'running') {
			endedProcesses.add(processKey(agent.name, handle));
			throw new Error(
				`Process '${handle}' is ${status.state}; connect requires a running process.`,
			);
		}
		if (endedProcesses.has(processKey(agent.name, handle)))
			throw new Error(`Process '${handle}' has ended and cannot be connected again.`);
		return status;
	};

	const checkRegisteredStatus = async (
		connection: MutableConnection,
		signal?: AbortSignal,
	): Promise<void> => {
		const status = await processes.find(
			{ name: connection.owner },
			connection.process.handle,
			signal,
		);
		const ended =
			status.state !== 'running' ||
			status.agent !== connection.owner ||
			status.handle !== connection.process.handle ||
			endedProcesses.has(processKey(connection.owner, connection.process.handle));
		if (ended) markEnded(connection, status);
		else connection.process = status;
	};

	const checkExisting = async (
		connection: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		signal: AbortSignal,
	): Promise<void> => {
		if (connection?.available) await checkRegisteredStatus(connection, signal);
		if (connection !== undefined && !connection.available && connection.owner !== agent.name)
			throw new Error(`Only '${connection.owner}' can replace connection '${input.name}'.`);
		if (connection?.available && !sameIdentity(connection, agent, input.process, input.port))
			throw new Error(`Connection '${input.name}' is already assigned to a running process.`);
	};

	const checkReusable = (
		current: MutableConnection,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		index: SensorIndex,
	): void => {
		if (!sameIdentity(current, agent, input.process, input.port))
			throw new Error(`Connection '${input.name}' is already assigned to a running process.`);
		if (!sameSource(current.source, index.source))
			throw new Error('The sensor launch source changed for this process.');
		if (endedProcesses.has(processKey(agent.name, input.process)))
			throw new Error(`Process '${input.process}' has ended and cannot be connected again.`);
	};

	const assertReplacementOwner = (
		initial: MutableConnection | undefined,
		current: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
	): void => {
		if (current !== initial)
			throw new Error(`Connection '${input.name}' changed while it was being validated.`);
		if (current !== undefined && current.owner !== agent.name)
			throw new Error(`Only '${current.owner}' can replace connection '${input.name}'.`);
	};

	const assertCommitAllowed = (
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		active: AbortSignal,
	): void => {
		if (active.aborted || closing !== undefined)
			throw active.reason ?? new Error('Workspace is disposing.');
		if (endedProcesses.has(processKey(agent.name, input.process)))
			throw new Error(`Process '${input.process}' has ended and cannot be connected again.`);
	};

	const checkReplacement = (
		initial: MutableConnection | undefined,
		current: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		active: AbortSignal,
	): void => {
		assertReplacementOwner(initial, current, agent, input);
		assertCommitAllowed(agent, input, active);
	};

	const chooseRegistration = (
		initial: MutableConnection | undefined,
		current: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		index: SensorIndex,
		active: AbortSignal,
	): MutableConnection | undefined => {
		if (
			current &&
			(current.available ||
				(current.detached && sameIdentity(current, agent, input.process, input.port)))
		) {
			checkReusable(current, agent, input, index);
			return current;
		}
		checkReplacement(initial, current, agent, input, active);
		return undefined;
	};

	const newRegistration = (
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		process: ProcessStatus,
		index: SensorIndex,
		transport: WorkspacePort,
	): MutableConnection => {
		const source = freezeSource(index.source);
		const connection: MutableConnection = {
			name: input.name,
			owner: agent.name,
			process,
			port: input.port,
			hostname: ports.hostname,
			source,
			index: freezeIndex(index, source),
			client: createSensorClient(transport.url),
			available: true,
			transport,
		};
		return connection;
	};

	const commitCandidate = async (
		initial: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		process: ProcessStatus,
		index: SensorIndex,
		transport: WorkspacePort,
		active: AbortSignal,
	): Promise<RegisteredSensorConnection> => {
		assertCommitAllowed(agent, input, active);
		const current = byName.get(input.name);
		const reusable = chooseRegistration(initial, current, agent, input, index, active);
		if (reusable !== undefined) return refresh(reusable, process, index, transport);
		const connection = newRegistration(agent, input, process, index, transport);
		// The claim is committed without an await, so concurrent names have one winner.
		byName.set(input.name, connection);
		notify('connected', connection);
		if (current !== undefined) await disposeTransport(current).catch(() => undefined);
		return connection;
	};

	const prepareCandidate = async (
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		signal: AbortSignal,
	): Promise<{
		readonly process: ProcessStatus;
		readonly index: SensorIndex;
		readonly transport: WorkspacePort;
	}> => {
		const before = await assertRunning(agent, input.process, signal);
		const transport = await ports.open(agent, input.port, signal);
		transports.add(transport);
		try {
			const index = await createSensorClient(transport.url).index(signal);
			validateIndex(index);
			const after = await assertRunning(agent, input.process, signal);
			if (before.handle !== after.handle || before.agent !== after.agent)
				throw new Error('The process identity changed while connecting.');
			return { process: after, index, transport };
		} catch (error) {
			await closeTransport(transport).catch(() => undefined);
			throw error;
		}
	};

	const assertActive = (signal: AbortSignal): void => {
		if (closing !== undefined || signal.aborted)
			throw signal.reason ?? new Error('Workspace is disposing.');
	};

	const runConnect = async (
		initial: MutableConnection | undefined,
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		signal: AbortSignal,
	): Promise<RegisteredSensorConnection> => {
		await checkExisting(initial, agent, input, signal);
		if (closing !== undefined) throw new Error('Sensor connections are closing.');
		const prepared = await prepareCandidate(agent, input, signal);
		let transferred = false;
		try {
			assertActive(signal);
			const connection = await commitCandidate(
				initial,
				agent,
				input,
				prepared.process,
				prepared.index,
				prepared.transport,
				signal,
			);
			transferred = true;
			return connection;
		} finally {
			if (!transferred) await closeTransport(prepared.transport).catch(() => undefined);
		}
	};

	const connect = async (
		agent: WorkspaceAgent,
		input: { readonly name: string; readonly process: string; readonly port: number },
		signal?: AbortSignal,
	): Promise<RegisteredSensorConnection> => {
		if (closing !== undefined) throw new Error('Sensor connections are closing.');
		if (!/^[a-z][a-z0-9-]*(?![\s\S])/.test(input.name))
			throw new Error(`Invalid connection name '${input.name}'.`);
		if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)
			throw new Error('The sensor port must be an integer from 1 through 65535.');

		const initial = byName.get(input.name);

		const controller = new AbortController();
		const combined =
			signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]);
		const promise = runConnect(initial, agent, input, combined);
		const attempt: Attempt = { controller, promise, name: input.name, owner: agent.name };
		attempts.add(attempt);
		try {
			return await promise;
		} finally {
			attempts.delete(attempt);
		}
	};

	const getActive = async (
		connection: MutableConnection,
		name: string,
		signal?: AbortSignal,
	): Promise<RegisteredSensorConnection | undefined> => {
		if (!connection.available || !connection.index.sensors.some((one) => one.name === name))
			return undefined;
		const process = await processes.find(
			{ name: connection.owner },
			connection.process.handle,
			signal,
		);
		if (
			process.state !== 'running' ||
			process.agent !== connection.owner ||
			endedProcesses.has(processKey(connection.owner, connection.process.handle))
		) {
			markEnded(connection, process);
			return undefined;
		}
		if (!connection.available || byName.get(connection.name) !== connection) return undefined;
		connection.process = process;
		return connection;
	};

	const get = async (
		sensor: string,
		signal?: AbortSignal,
	): Promise<RegisteredSensorConnection | undefined> => {
		const slash = sensor.indexOf('/');
		if (slash < 1 || slash !== sensor.lastIndexOf('/')) return undefined;
		const connection = byName.get(sensor.slice(0, slash));
		if (closing !== undefined || connection === undefined) return undefined;
		return getActive(connection, sensor.slice(slash + 1), signal);
	};

	const readDiscoveryStatus = async (
		connection: MutableConnection,
		signal?: AbortSignal,
	): Promise<boolean> => {
		try {
			await checkRegisteredStatus(connection, signal);
			return true;
		} catch {
			if (signal?.aborted) throw signal.reason;
			return false;
		}
	};

	const discoveryState = async (
		connection: MutableConnection,
		signal?: AbortSignal,
	): Promise<SensorDiscovery['state']> => {
		if (connection.detached) return 'disconnected';
		if (!connection.available) return 'unavailable';
		const checked = await readDiscoveryStatus(connection, signal);
		if (connection.detached) return 'disconnected';
		if (!connection.available) return 'unavailable';
		return checked ? 'connected' : 'unknown';
	};

	const listConnection = async (
		connection: MutableConnection,
		signal?: AbortSignal,
	): Promise<SensorDiscovery | undefined> => {
		const state = await discoveryState(connection, signal);
		if (byName.get(connection.name) !== connection) return undefined;
		return discovery(connection, state);
	};

	const list = async (signal?: AbortSignal): Promise<readonly SensorDiscovery[]> => {
		if (closing !== undefined) return [];
		const discoveries = await Promise.all(
			[...byName.values()].map((connection) => listConnection(connection, signal)),
		);
		if (closing !== undefined) return [];
		return discoveries.filter((one): one is SensorDiscovery => one !== undefined);
	};

	const abortRefreshes = (agent: WorkspaceAgent, name: string) => {
		for (const attempt of attempts) {
			if (attempt.name === name && attempt.owner === agent.name)
				attempt.controller.abort(new Error('Sensor connection was disconnected.'));
		}
	};

	const disconnect = async (
		agent: WorkspaceAgent,
		name: string,
		signal?: AbortSignal,
	): Promise<void> => {
		if (closing !== undefined) throw new Error('Sensor connections are closing.');
		signal?.throwIfAborted();
		const connection = byName.get(name);
		if (!connection) throw new Error(`Unknown sensor connection '${name}'.`);
		if (connection.owner !== agent.name)
			throw new Error(`Only '${connection.owner}' can disconnect '${name}'.`);
		abortRefreshes(agent, name);
		if (!connection.detached) {
			connection.available = false;
			connection.detached = true;
			notify('disconnected', connection);
		}
		await disposeTransport(connection);
	};

	const close = (): Promise<void> => {
		if (closing !== undefined) return closing;
		closing = (async () => {
			unsubscribe();
			const connections = [...byName.values()];
			for (const connection of connections) {
				if (!connection.available) continue;
				connection.available = false;
				notify('unavailable', connection);
			}
			listeners.clear();
			for (const attempt of attempts)
				attempt.controller.abort(new Error('Workspace is disposing.'));
			const closeTransports = Promise.allSettled([...transports].map(closeTransport));
			await Promise.allSettled([...attempts].map((attempt) => attempt.promise));
			await closeTransports;
			await Promise.allSettled([...transports].map(closeTransport));
		})();
		return closing;
	};

	return Object.freeze({
		connect,
		disconnect,
		get,
		list,
		close,
		subscribe(listener: (event: SensorConnectionEvent) => void) {
			if (closing !== undefined) return () => {};
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
}
