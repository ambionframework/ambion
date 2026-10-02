/**
 * The collaboration kernel: define agents and tools, supply fixed definitions,
 * then seat agents and address participants by name. People visit rooms and
 * their questions open exchanges. Agents can seat and unseat colleagues.
 * An optional summary activation summarizes each completed exchange. The journal preserves the facts
 * needed to resume a room; executable definitions are supplied for each run.
 */

export type {
	AmbionTool,
	Reminder,
	ReminderSeat,
	ToolBundle,
	ToolConcurrency,
	ToolContent,
	ToolContext,
	ToolResult,
	ToolUpdate,
} from './bundle.ts';
export { contentText } from './bundle.ts';
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { defineAgent, definePerson, defineTool } from './define.ts';
export type { AmbionErrorCode } from './errors.ts';
export { AmbionError } from './errors.ts';
export { DEFAULT_SPEAKING } from './execution/render.ts';
export { loggedToolResult } from './execution/trace.ts';
export type { CreateRuntimeOptions, Execution, Runtime } from './host/runtime.ts';
export { createRuntime, defaultRuntime, systemClock } from './host/runtime.ts';
export type { CommitUri, CommitVia, RoomUri, SnapshotUri } from './refs.ts';
export {
	commitUri,
	messageUri,
	parseCommitUri,
	parseRoomUri,
	parseSnapshotUri,
	REF_LIMITS,
	roomUri,
	snapshotUri,
} from './refs.ts';
export { awaitingFor } from './room/read.ts';
export type {
	ExchangeHandle,
	ExchangeRead,
	PostInput,
	ReadRoomOptions,
	ResumeRoomOptions,
	Room,
	RoomRead,
	StartRoomOptions,
	Visit,
} from './room.ts';
export { readExchange, readRoom, resumeRoom, startRoom } from './room.ts';
export type { ScheduledSay } from './scheduling.ts';
export type { SessionFacts } from './session-facts.ts';
export type {
	ActivationEvent,
	ActivationOutcome,
	AgentDefinition,
	AgentParticipant,
	Attention,
	Clock,
	DismissedMessage,
	Exchange,
	ExchangeActivation,
	ExchangeOutcome,
	ExchangeRange,
	ExchangeRef,
	Executor,
	Message,
	Participant,
	PersonDefinition,
	PersonParticipant,
	PostedMessage,
	PresenceChange,
	PresenceMessage,
	PresenceStatus,
	RoomEvent,
	RoomNotification,
	SaidMessage,
	SeatOptions,
	SeatStatus,
	Seq,
	Step,
	SummaryMessage,
	SummaryOutcome,
	TracedStep,
	TraceLogger,
	TracePolicy,
	TraceStep,
	Usage,
	VendorSession,
} from './types.ts';
export { addUsage, isPosted, isPresence, isSaid, isSummary } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
