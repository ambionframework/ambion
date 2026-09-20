/**
 * The host's own entry: the wire between a room and a seat, and everything
 * beyond the application view that a host needs from a `Runtime`.
 *
 * A seat makes three calls — `view`, `commit` and `lease` — and the room
 * answers them. `RoomProtocol` names the three, `AgentPort` names the side the
 * room calls back, and `Transport` is what connects one to the other.
 * `inProcessTransport` is the default: it receives a room-call facade and
 * a separate executor context. Nothing crosses a process. A host that puts the seats
 * somewhere else writes its own, and `AgentRunner` is the seat side to run
 * there. `@ambionframework/cloudflare` is one such host.
 *
 * Every shape a call carries is here, because a transport serialises them.
 * `assertWire` and `roundTrip` hold a value to what the wire can carry.
 *
 * `hostingOf(runtime)` is the other half: the journal namespace, wake and
 * retry policy, and the room lifecycle registry, none of which the main
 * entry exposes. An executor package, such as `@ambionframework/pi`, builds
 * on the executor contract and the rendering helpers this entry exports.
 *
 * The main entry is what an application needs to build a room, and it names
 * no part of this. The execution boundary section of `docs/agent.md` is the
 * design contract for the wire.
 */

export type { ExecutorOptions } from './define.ts';
export { describeExecutor, SAY, SEAT, UNSEAT } from './define.ts';
export type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	PassInput,
	PassResult,
} from './execution/executor.ts';
export { refusal, renderActivation, renderLine } from './execution/render.ts';
export { AgentRunner, inProcessTransport } from './execution/runner.ts';
export { summaryToolDescription } from './execution/summary.ts';
export type {
	AgentExecutionContext,
	Execution,
	ExecutionConnector,
	ExecutionHost,
	Hosting,
	Limits,
	Transport,
} from './host/runtime.ts';
export { callLimits, hostingOf, runningRoom } from './host/runtime.ts';
export type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	AgentPort,
	CollaborationContext,
	CommitRequest,
	CommitResult,
	ContextParticipant,
	Intent,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	Stale,
	Steer,
	ViewRange,
	ViewResponse,
	Wake,
} from './protocol.ts';
export { assertWire, roundTrip } from './protocol.ts';
export type {
	AgentDefinition,
	AgentExecutor,
	Clock,
	EndReason,
	ExecutionEvent,
	FailureCause,
	Seq,
} from './types.ts';
