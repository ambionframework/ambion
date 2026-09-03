/**
 * The Ambion runtime: five primitives, and a dependency for every other concern.
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
 * retires a workspace for good. The room's assistant composes the room at
 * the open of an exchange, from the agents held in reserve, and writes the
 * one message a person reads when the exchange closes. The design contracts
 * live in docs/agent.md, docs/exchange.md, docs/presence.md,
 * docs/assistant.md, docs/workspace.md and docs/roster.md.
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
export type {
	MemoryBackendFile,
	MemoryBackendOptions,
	MemoryWorkspaceBackend,
	SeedWriter,
} from './just-bash.ts';
// A workspace over a real directory, or the in-memory default with seeding
// and read-back. Neither import is needed for the in-memory default's own
// use inside `defineWorkspace` — only a host that wants to seed or read it.
export { directoryBackend, memoryBackend } from './just-bash.ts';
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
export { isPresence, isSpoken, isSummary } from './types.ts';
export type { DefineWorkspaceOptions } from './workspace.ts';
export { defineWorkspace, destroyWorkspace } from './workspace.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
