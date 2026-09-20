/**
 * The collaboration kernel: define agents and tools, supply a fixed catalog,
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
export type { CreateRuntimeOptions, Runtime } from './host/runtime.ts';
export { createRuntime, defaultRuntime, systemClock } from './host/runtime.ts';
export type {
	ExchangeHandle,
	ExchangeSnapshot,
	ReadRoomOptions,
	ResumeRoomOptions,
	Room,
	RoomSnapshot,
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
	HumanDefinition,
	HumanParticipantInfo,
	Message,
	ModelResolver,
	ParticipantInfo,
	PiExecutor,
	PresenceChange,
	PresenceMessage,
	PresenceStatus,
	RoomNotification,
	SeatStatus,
	Seq,
	SpokenMessage,
	SummaryMessage,
	SummaryOutcome,
	ToolBundle,
	ToolContext,
} from './types.ts';
export { isPresence, isSpoken, isSummary } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
