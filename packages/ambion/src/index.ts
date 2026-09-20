/**
 * The collaboration kernel: define agents and tools, supply fixed definitions,
 * then seat agents and address participants by name. People visit rooms and
 * their questions open exchanges. Agents can seat and unseat colleagues.
 * An optional closing activation summarizes each completed exchange. The journal preserves the facts
 * needed to resume a room; executable definitions are supplied for each run.
 */

export type {
	DefineAgentOptions,
	DefineHumanOptions,
	DefineToolOptions,
	PiOptions,
} from './define.ts';
export { defineAgent, defineHuman, defineTool, fromPiTool, pi } from './define.ts';
export type { AmbionErrorCode } from './errors.ts';
export { AmbionError } from './errors.ts';
export type { CreateRuntimeOptions, Runtime } from './host/runtime.ts';
export { createRuntime, defaultRuntime, systemClock } from './host/runtime.ts';
export type { RoomUri } from './refs.ts';
export { exchangeUri, parseRoomUri, roomUri } from './refs.ts';
export type {
	ExchangeHandle,
	ExchangeRead,
	ReadRoomOptions,
	ResumeRoomOptions,
	Room,
	RoomRead,
	StartRoomOptions,
	Visit,
} from './room.ts';
export { readExchange, readRoom, resumeRoom, startRoom } from './room.ts';
export type {
	AgentDefinition,
	AgentExecutor,
	AgentParticipantInfo,
	AmbionTool,
	Attention,
	Clock,
	ClosedExchange,
	ExchangeRef,
	ExchangeView,
	ExecutionEvent,
	HumanDefinition,
	HumanParticipantInfo,
	Message,
	ModelResolver,
	ParticipantInfo,
	PiExecutor,
	PresenceChange,
	PresenceMessage,
	PresenceStatus,
	RoomEvent,
	RoomNotification,
	SeatOptions,
	SeatStatus,
	Seq,
	SpokenMessage,
	Step,
	SummaryMessage,
	SummaryOutcome,
	ToolBundle,
	ToolContext,
	TracePolicy,
	TraceStep,
	Usage,
} from './types.ts';
export { isPresence, isSpoken, isSummary } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
