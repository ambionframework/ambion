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
 * calls it once. A host that puts the seats somewhere else writes an
 * execution whose port crosses the boundary, and runs an `AgentRunner`
 * there.
 * `@ambionframework/cloudflare` is one such host.
 *
 * Every shape a call carries is plain data, because a remote port
 * serialises it.
 *
 * `hostingOf(runtime)` is the other half: the clock, the storage, the
 * limits, the journal namespace, the executions, and `evict`, none of which
 * the main entry exposes. An executor package, such as `@ambionframework/pi`, builds
 * on the executor contract this entry exports: the core hands each pass its
 * prompt, its room tools, and the session to resume.
 *
 * The main entry is what an application needs to build a room, and it names
 * no part of this. The execution boundary section of `docs/executors.md` is the
 * design contract for the wire.
 */

export type { ExecutorBaseOptions, ExecutorOptions } from './define.ts';
export { describeExecutor, executorOfKind, pickPresent, present } from './define.ts';
export type {
	ActivationOpener,
	ExecutorActivation,
	Pass,
	PassInput,
	PassRecord,
	PassResult,
	ReadRange,
	RunningActivation,
} from './execution/executor.ts';
export { classifyCause, failedPass, PermanentError, providerMessage } from './execution/failure.ts';
export type { RoomTool, RoomToolOptions } from './execution/room-tools.ts';
export { ROOM_SERVER, toolContext } from './execution/room-tools.ts';
export { defineExecution, localExecution } from './execution/route.ts';
export { AgentRunner } from './execution/runner.ts';
export type { StepSink, TraceOpener, TraceSink } from './execution/trace.ts';
export type {
	AgentExecutionContext,
	ConnectorRequest,
	Execution,
	ExecutionHost,
} from './host/runtime.ts';
export { hostingOf, runningRoom } from './host/runtime.ts';
export type {
	ActivationSpec,
	ActivationView,
	AgentPort,
	CommitRequest,
	CommitResult,
	Intent,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	Steer,
	ViewResponse,
	Wake,
} from './protocol.ts';
export { visitOf } from './room.ts';
export type {
	AgentDefinition,
	ExecutionEvent,
	Executor,
	FailureCause,
	HarnessSession,
	Seq,
} from './types.ts';
