/**
 * The host's own entry: the wire between a room and a seat, and everything
 * beyond the application view that a host needs from a `Runtime`.
 *
 * A seat makes three calls — `view`, `commit` and `lease` — and the room
 * answers them. `RoomProtocol` names the three, and `AgentPort` names the
 * side the room calls back. An `Execution` connects one to the other: its
 * connector returns the port of each seat. `localExecution` builds the
 * execution of one executor kind, whose port is an `AgentRunner` in this
 * process. `defineExecution` defines an executor family: the executions of
 * one kind by options, and the default of that kind. An executor package
 * calls it once. A
 * host that puts the seats somewhere else writes an execution whose port
 * crosses the boundary, and runs an `AgentRunner` there.
 * `@ambionframework/cloudflare` is one such host.
 *
 * Every shape a call carries is here, because a remote port serialises
 * them. `assertWire` and `roundTrip` hold a value to what the wire can
 * carry.
 *
 * `hostingOf(runtime)` is the other half: the journal namespace, wake and
 * retry policy, and the room lifecycle registry, none of which the main
 * entry exposes. An executor package, such as `@ambionframework/pi`, builds
 * on the executor contract this entry exports: the core hands each pass its
 * prompt, its room tools, and the session to resume.
 *
 * The main entry is what an application needs to build a room, and it names
 * no part of this. The execution boundary section of `docs/executors.md` is the
 * design contract for the wire.
 */

export type { AgentExecutorBaseOptions, ExecutorOptions } from './define.ts';
export {
	DEFAULT_TRACE,
	DISMISS,
	describeExecutor,
	executorOfKind,
	RECALL,
	SAY,
	SCHEDULE,
	SEAT,
	UNSEAT,
} from './define.ts';
export type {
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
	PassInput,
	PassRecord,
	PassResult,
	ReadRange,
} from './execution/executor.ts';
export { classifyCause, PERMANENT_STATUS, providerMessage } from './execution/failure.ts';
export { REMINDER_TIMEOUT_MS } from './execution/reminders.ts';
export { refusal, summaryToolDescription } from './execution/render.ts';
export type {
	RoomTool,
	RoomToolContent,
	RoomToolOptions,
	RoomToolResult,
} from './execution/room-tools.ts';
export { toolContext } from './execution/room-tools.ts';
export { defineExecution, type ExecutionBuild, localExecution } from './execution/route.ts';
export { AgentRunner } from './execution/runner.ts';
export type { StepSink, TraceOpener, TraceSink } from './execution/trace.ts';
export type {
	AgentExecutionContext,
	ConnectorRequest,
	Execution,
	ExecutionConnector,
	ExecutionHost,
	Hosting,
	Limits,
} from './host/runtime.ts';
export { callLimits, DEFAULT_TRACE_LIMITS, hostingOf, runningRoom } from './host/runtime.ts';
export type {
	ActivationPurpose,
	ActivationSpec,
	ActivationView,
	AgentPort,
	CollaborationContext,
	CommitOutcome,
	CommitRequest,
	CommitResult,
	ContextParticipant,
	Intent,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	Stale,
	Steer,
	ViewResponse,
	Wake,
} from './protocol.ts';
export { assertWire, classifyCommit, roundTrip } from './protocol.ts';
export { renderLine } from './record.ts';
export { visitOf } from './room.ts';
export type {
	AgentDefinition,
	AgentExecutor,
	Clock,
	EndReason,
	ExecutionEvent,
	FailureCause,
	HarnessSession,
	Seq,
} from './types.ts';
