/**
 * Advanced seat protocol for transport implementors. These JSON-safe values
 * are the complete contract crossing a room/seat boundary.
 */
export type { SeatContext } from './seat/seat.ts';
export { inProcessTransport, SeatActor } from './seat/seat.ts';
export type {
	ActivationView,
	Commit,
	CommitResponse,
	Lease,
	LeaseResponse,
	LeaseRow,
	SeatPort,
	SeatRoom,
	Stale,
	ViewResponse,
	Wake,
} from './wire.ts';
export { assertWire, roundTrip } from './wire.ts';
