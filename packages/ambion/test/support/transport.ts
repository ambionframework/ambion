/**
 * A transport for the tests: it proves every request and response between a
 * seat and its room is plain JSON.
 */
import type { RunningRoom, Transport } from '../../src/index.ts';
import { assertWire, roundTrip } from '../../src/index.ts';

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
				view: async (id) => check('view response', await room.view(check('view', id))),
				commit: async (commit) =>
					check('commit response', await room.commit(check('commit', commit))),
				lease: async (lease) => check('lease response', await room.lease(check('lease', lease))),
			};
			const port = transport.connect(wrapped, seat, runtime);
			return { wake: (wake) => port.wake(check('wake', wake)) };
		},
	};
}
