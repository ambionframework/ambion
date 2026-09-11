/** Stable JSON values exchanged by a room and a remote seat. */
export type {
	ActivationView,
	CloseRow,
	Commit,
	CommitResponse,
	EndReason,
	Hand,
	Intent,
	Lease,
	LeaseResponse,
	LeaseRow,
	CompositionRow,
	RunRow,
	SeatPort,
	SeatRoom,
	SeatRow,
	Stale,
	ViewResponse,
	Wake,
} from './wire.ts';
export { assertWire, roundTrip } from './wire.ts';
