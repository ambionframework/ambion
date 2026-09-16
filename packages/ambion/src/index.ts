/**
 * The collaboration kernel: define agents and tools, supply a fixed catalog,
 * then seat agents and address participants by name. People visit rooms and
 * their questions open exchanges. The assistant can select agents from the
 * reserve and summarize completed exchanges. The journal preserves the facts
 * needed to resume a room; executable definitions are supplied for each run.
 */

export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { defineAgent, defineHuman, defineTool } from './define.ts';
export type { CreateRuntimeOptions, Runtime } from './host/runtime.ts';
export { createRuntime, defaultRuntime, systemClock } from './host/runtime.ts';
export type {
	ExchangeHandle,
	ReadRoomOptions,
	ResumeRoomOptions,
	Room,
	RoomSnapshot,
	StartRoomOptions,
	Visit,
} from './room.ts';
export { readRoom, resumeRoom, startRoom } from './room.ts';
export type {
	AgentDefinition,
	AgentSeatInfo,
	AmbionTool,
	Attention,
	Clock,
	ClosedExchange,
	Exchange,
	HumanDefinition,
	HumanSeatInfo,
	Message,
	ModelResolver,
	PresenceChange,
	PresenceMessage,
	PresenceStatus,
	RoomNotification,
	SeatInfo,
	SeatStatus,
	Seq,
	SpokenMessage,
	SummaryMessage,
	ToolBundle,
	ToolContext,
} from './types.ts';
export { isPresence, isSpoken, isSummary, seatSessionId } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
