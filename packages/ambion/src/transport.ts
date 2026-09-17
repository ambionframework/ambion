/**
 * The wire between a room and a seat, for a host that runs the two apart.
 *
 * A seat makes three calls — `view`, `commit` and `lease` — and the room
 * answers them. `SeatRoom` names the three, `SeatPort` names the side the
 * room calls back, and `Transport` is what connects one to the other.
 * `TaskSeatRoom` adds `task`, `taskUpdate`, and `taskSay` for Task execution.
 * `inProcessTransport` is the default: it receives a room-call facade and
 * a separate executor context. Nothing crosses a process. A host that puts the seats
 * somewhere else writes its own, and `AgentRunner` is the seat side to run
 * there. `@ambionframework/cloudflare` is one such host.
 *
 * Every shape a call carries is here, because a transport serialises them.
 * `assertWire` and `roundTrip` hold a value to what the wire can carry.
 *
 * The main entry is what a host needs to build a room, and it names no part
 * of this. `docs/agent.md` §6 is the design contract for the wire.
 */

export { AgentRunner, inProcessTransport } from './execution/runner.ts';
export {
	createExecutionServices,
	type ExecutionServices,
	type ExecutionServicesOptions,
	seatSessionId,
} from './execution/services.ts';
export type { SeatContext, Transport } from './host/runtime.ts';
export { runningRoom } from './host/runtime.ts';
export type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	CollaborationContext,
	CommitRequest,
	CommitResult,
	ContextParticipant,
	Intent,
	LeaseRequest,
	LeaseResponse,
	SeatPort,
	SeatRoom,
	Stale,
	Steer,
	TaskCreateRequest,
	TaskResponse,
	TaskSayRequest,
	TaskSeatRoom,
	TaskToolResult,
	TaskUpdateRequest,
	ViewResponse,
	Wake,
} from './protocol.ts';
export { assertWire, roundTrip } from './protocol.ts';
export type { EndReason } from './types.ts';
