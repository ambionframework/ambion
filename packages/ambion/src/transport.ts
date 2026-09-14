/**
 * The wire between a room and a seat, for a host that runs the two apart.
 *
 * A seat makes three calls — `view`, `commit` and `lease` — and the room
 * answers them. `SeatRoom` names the three, `SeatPort` names the side the
 * room calls back, and `Transport` is what connects one to the other.
 * `inProcessTransport` is the one every room uses by default: it holds the
 * room directly, and nothing crosses a process. A host that puts the seats
 * somewhere else writes its own, and `SeatActor` is the seat side to run
 * there. `@ambionframework/cloudflare` is one such host.
 *
 * Every shape a call carries is here, because a transport serialises them.
 * `assertWire` and `roundTrip` hold a value to what the wire can carry.
 *
 * The main entry is what a host needs to build a room, and it names no part
 * of this. `docs/agent.md` §6 is the design contract for the wire.
 */

export type { RunningRoom, Transport } from './host/runtime.ts';
export type { SeatContext } from './seat/seat.ts';
export { inProcessTransport, SeatActor } from './seat/seat.ts';
export type {
	ActivationView,
	Checkpoint,
	Close,
	Commit,
	CommitResponse,
	Composition,
	EndReason,
	Fence,
	Intent,
	Lease,
	LeaseChange,
	LeaseHold,
	LeaseResponse,
	Role,
	Seating,
	SeatPort,
	SeatRoom,
	Stale,
	ViewResponse,
	Wake,
} from './wire.ts';
export { assertWire, roundTrip } from './wire.ts';
