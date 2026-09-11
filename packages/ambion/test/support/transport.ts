/**
 * Transports for the tests: one that proves every request and response is
 * plain JSON, and one that loses, repeats or delays them on purpose.
 */
import type { Clock, RunningRoom, Transport } from '../../src/host.ts';
import type { SeatPort } from '../../src/protocol.ts';
import { assertWire, roundTrip } from '../../src/protocol.ts';

export interface SerializingTransport extends Transport {
	/** Every value that would not have survived the wire. Empty when the design holds. */
	readonly violations: string[];
}

/**
 * Every request and every response crosses as JSON, and the test reads what
 * would not have survived. The value the other side receives is the round
 * trip, so nothing shares an object across the boundary.
 */
export function serializing(transport: Transport): SerializingTransport {
	const violations: string[] = [];
	const check = <T>(what: string, value: T): T => {
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
	return {
		violations,
		connect(room, seat, runtime) {
			const wrapped: RunningRoom = {
				name: room.name,
				stream: room.stream,
				model: room.model,
				sessions: room.sessions,
				emit: (event) => room.emit(event),
				evict: () => room.evict(),
				view: async (id) => check('view response', await room.view(check('view', id))),
				commit: async (commit) =>
					check('commit response', await room.commit(check('commit', commit))),
				lease: async (lease) => check('lease response', await room.lease(check('lease', lease))),
			};
			const port = transport.connect(wrapped, seat, runtime);
			return {
				wake: (wake) => port.wake(check('wake', wake)),
				cut: (activation) => port.cut(check('cut', activation)),
			};
		},
	};
}

export type Operation = 'wake' | 'cut' | 'view' | 'commit' | 'lease';

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
 * A transport that fails the way a network does. Each fault is taken by the
 * first request it matches, in order. A dropped wake is lost; a dropped
 * room call rejects, so the seat never learns the outcome. A
 * duplicated request is sent twice. A delayed one waits on the clock. A
 * held one waits for `hold` to run, so a test lands something in between.
 */
export function faultyTransport(transport: Transport, faults: Fault[], clock: Clock): Transport {
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
	return {
		connect(room, seat, runtime) {
			const wrapped: RunningRoom = {
				name: room.name,
				stream: room.stream,
				model: room.model,
				sessions: room.sessions,
				emit: (event) => room.emit(event),
				evict: () => room.evict(),
				view: (id) => through('view', id, () => room.view(id)),
				commit: (commit) => through('commit', commit, () => room.commit(commit)),
				lease: (lease) => through('lease', lease, () => room.lease(lease)),
			};
			const port: SeatPort = transport.connect(wrapped, seat, runtime);
			return {
				wake: (wake) => through('wake', wake, () => port.wake(wake)).catch(() => {}),
				cut: (activation) => through('cut', activation, () => port.cut(activation)).catch(() => {}),
			};
		},
	};
}
