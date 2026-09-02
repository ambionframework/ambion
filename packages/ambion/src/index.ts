/**
 * The Ambion runtime: five primitives, one dependency that does the rest.
 *
 * `defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
 * gives agents hands, `defineWorkspace` names the identity and data boundary
 * an agent's tools reach into, `seated` chooses what wakes a seat — with
 * `passive` and `attentive` for the two points worth naming — and
 * `startSession` brings up a named room the agents work in and people visit.
 * A person's question opens an exchange, the room works, and quiescence
 * closes it — the exchange every other feature reads. `stopSession` takes
 * the room down, `readSession` reads a name without starting anything,
 * `visitSession` puts a person in a running room, and `destroyWorkspace`
 * retires a workspace for good. A person's assistant writes the one message
 * they read when an exchange closes. The design contracts live in
 * docs/agent.md, docs/presence.md, docs/assistant.md and docs/workspace.md.
 */

export type {
	ExecutionEnv,
	SessionMetadata,
	SessionRepo,
	SessionStorage,
} from '@earendil-works/pi-agent-core';
// Storage is Pi's, re-exported — Ambion adds no storage abstraction of its own.
// `ExecutionEnv` is what a workspace backend's `connect` returns, and Pi's too.
export {
	InMemorySessionRepo,
	InMemorySessionStorage,
	JsonlSessionRepo,
} from '@earendil-works/pi-agent-core';
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { attentive, defineAgent, defineHuman, defineTool, passive, seated } from './define.ts';
// The room's own exchange: what a question opened, and what quiescence closed.
export type { ClosedExchange, Exchange } from './exchange.ts';
// A workspace over a real directory. The in-memory default needs no import.
export { directoryBackend } from './just-bash.ts';
export type {
	ReadSessionOptions,
	Session,
	SessionView,
	StartSessionOptions,
	Visit,
} from './session.ts';
export { readSession, startSession, stopSession, visitSession } from './session.ts';
export type {
	AgentDefinition,
	AgentSeat,
	AgentSeatInfo,
	AmbionTool,
	Attention,
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
	WorkspaceBackend,
	WorkspaceHandle,
} from './types.ts';
export { isSpoken, isSummary } from './types.ts';
export type { DefineWorkspaceOptions } from './workspace.ts';
export { defineWorkspace, destroyWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
