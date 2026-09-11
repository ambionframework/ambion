/**
 * Ambion's application surface: define the participants and tools, give an
 * agent a workspace, and start or visit a session.
 *
 * Host adapters live at `@ambionframework/ambion/host`; the seat protocol
 * lives at `@ambionframework/ambion/protocol`.
 */

export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { attentive, defineAgent, defineHuman, defineTool, passive, seated } from './define.ts';
export type {
	ReadSessionOptions,
	ResumeSessionOptions,
	Session,
	SessionView,
	StartSessionOptions,
	Visit,
} from './session.ts';
export { readSession, resumeSession, startSession, stopSession, visitSession } from './session.ts';
export type { DefineWorkspaceOptions } from './tools/workspace.ts';
export { defineWorkspace, destroyWorkspace } from './tools/workspace.ts';
export type {
	AgentDefinition,
	AgentSeat,
	AgentSeatInfo,
	AmbionTool,
	Attention,
	ClosedExchange,
	Exchange,
	HumanDefinition,
	HumanSeatInfo,
	Message,
	Participant,
	PresenceChange,
	PresenceMessage,
	PresenceStatus,
	SeatedAgent,
	SeatInfo,
	SeatStatus,
	Seq,
	SessionEvent,
	SpokenMessage,
	SummaryMessage,
	ToolContext,
	Workspace,
	WorkspaceHandle,
} from './types.ts';
export { isPresence, isSpoken, isSummary } from './types.ts';
