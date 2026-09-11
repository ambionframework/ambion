/** The small, application-facing Ambion API. Host integration and wire
 * contracts live at `./host` and `./protocol`; Node adapters live at `./node`.
 */
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { defineAgent, defineHuman, defineTool } from './define.ts';
export type { Session, StartSessionOptions } from './session.ts';
export { startSession } from './session.ts';
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
export type { DefineWorkspaceOptions } from './tools/workspace.ts';
export { defineWorkspace } from './tools/workspace.ts';
