/**
 * Executions for the tests: one whose ports prove every request and
 * response is plain JSON, one whose ports lose, repeat or delay them on
 * purpose, and one whose ports the test writes itself.
 */

import type {
	AgentPort,
	ConnectorRequest,
	Execution,
	ExecutionConnector,
	RoomProtocol,
} from '../../src/hosting.ts';
import { assertWire, roundTrip } from '../../src/hosting.ts';
import type { Clock } from '../../src/index.ts';

/** How a test wraps the room calls of a seat and its port. Each part is optional. */
export interface Wrap {
	room?: (room: RoomProtocol, request: ConnectorRequest) => RoomProtocol;
	port?: (port: AgentPort, request: ConnectorRequest) => AgentPort;
}

/** `execution`, with the room calls and the port of each seat that it connects wrapped. */
export function around(execution: Execution, wrap: Wrap): Execution {
	return {
		...(execution.kind === undefined ? {} : { kind: execution.kind }),
		connector(host) {
			const inner: ExecutionConnector = execution.connector(host);
			return {
				connect(room, request) {
					const port = inner.connect(wrap.room?.(room, request) ?? room, request);
					return wrap.port?.(port, request) ?? port;
				},
			};
		},
	};
}

/** An execution of every kind whose port `connect` writes. It runs no seat. */
export function portExecution(
	connect: (room: RoomProtocol, request: ConnectorRequest) => AgentPort,
): Execution {
	return { connector: () => ({ connect }) };
}

export interface SerializingExecution extends Execution {
	/** Every value that would not have survived the wire. Empty when the design holds. */
	readonly violations: string[];
	/** How many values crossed. A test reads it to know that the check ran. */
	readonly crossed: () => number;
}

/**
 * Every request and every response crosses as JSON, and the test reads what
 * would not have survived. The value the other side receives is the round
 * trip, so nothing shares an object across the boundary.
 */
export function serializing(execution: Execution): SerializingExecution {
	const violations: string[] = [];
	let crossed = 0;
	const check = <T>(what: string, value: T): T => {
		crossed += 1;
		try {
			assertWire(value);
			const back = roundTrip(value);
			if (JSON.stringify(back) !== JSON.stringify(value)) violations.push(`${what}: changed`);
			return back;
		} catch (error) {
			violations.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
			return roundTrip(value);
		}
	};
	const wrapped = around(execution, {
		room: (room) => ({
			view: async (id, range) =>
				check(
					'view response',
					await room.view(
						check('view', id),
						range === undefined ? undefined : check('view range', range),
					),
				),
			commit: async (commit) =>
				check('commit response', await room.commit(check('commit', commit))),
			lease: async (lease) => check('lease response', await room.lease(check('lease', lease))),
		}),
		port: (port) => ({
			wake: (wake) => port.wake(check('wake', wake)),
			steer: (steer) => port.steer(check('steer', steer)),
			cut: (activation) => port.cut(check('cut', activation)),
		}),
	});
	return { ...wrapped, violations, crossed: () => crossed };
}

export type Operation = 'wake' | 'steer' | 'cut' | 'view' | 'commit' | 'lease';

export interface Fault {
	on: Operation;
	kind: 'drop' | 'duplicate' | 'delay' | 'hold';
	/** For `delay`: how long the request waits on the clock. */
	ms?: number;
	/** For `hold`: what happens while the request is held, before it is sent. */
	hold?: () => Promise<void>;
	/** Narrow the fault to one request; the first matching request takes it. */
	match?: (request: unknown) => boolean;
	/** Let this many matching requests through before the fault takes one. */
	skip?: number;
}

/**
 * An execution whose ports fail the way a network does. Each fault is taken
 * by the first request it matches, in order. A dropped wake is lost; a
 * dropped room call rejects, so the seat never learns the outcome. A
 * duplicated request is sent twice. A delayed one waits on the clock. A
 * held one waits for `hold` to run, so a test lands something in between.
 */
export function faulty(execution: Execution, faults: Fault[], clock: Clock): Execution {
	const take = (on: Operation, request: unknown): Fault | undefined => {
		const at = faults.findIndex((fault) => fault.on === on && (fault.match?.(request) ?? true));
		const fault = faults[at];
		if (fault === undefined) return undefined;
		if (fault.skip) {
			fault.skip -= 1;
			return undefined;
		}
		return faults.splice(at, 1)[0];
	};
	const wait = (ms: number) =>
		new Promise<void>((resolve) => clock.alarm(clock.now() + ms, resolve));
	const through = async <R>(
		on: Operation,
		request: unknown,
		send: () => Promise<R>,
	): Promise<R> => {
		const fault = take(on, request);
		if (fault?.kind === 'drop') throw new Error(`${on} dropped`);
		if (fault?.kind === 'delay') await wait(fault.ms ?? 0);
		if (fault?.kind === 'hold') await fault.hold?.();
		if (fault?.kind === 'duplicate') void send().catch(() => {});
		return send();
	};
	return around(execution, {
		room: (room) => ({
			view: (id, range) => through('view', id, () => room.view(id, range)),
			commit: (commit) => through('commit', commit, () => room.commit(commit)),
			lease: (lease) => through('lease', lease, () => room.lease(lease)),
		}),
		port: (port) => ({
			wake: (wake) => through('wake', wake, () => port.wake(wake)).catch(() => {}),
			steer: (steer) => through('steer', steer, () => port.steer(steer)).catch(() => {}),
			cut: (activation) => through('cut', activation, () => port.cut(activation)).catch(() => {}),
		}),
	});
}
