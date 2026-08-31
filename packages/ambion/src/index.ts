/**
 * The Ambion runtime: four primitives, one dependency that does the rest.
 *
 * `defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
 * gives agents hands, `seated` chooses what wakes one — with `passive` and
 * `attentive` for the two points worth naming — and `startSession` brings up a
 * named room the agents work in and people visit. A person's question opens an exchange, the room
 * works, and quiescence closes it — the round every other feature reads. `stopSession` takes it down, `readSession` reads
 * a name without starting anything, and `visitSession` puts a person in a
 * running room. A person may bring an aide, which writes the one message they
 * read when an exchange closes. The design contracts live in docs/agent.md,
 * docs/presence.md and docs/aide.md.
 */

export type { SessionMetadata, SessionRepo, SessionStorage } from '@earendil-works/pi-agent-core';
// Storage is Pi's, re-exported — Ambion adds no storage abstraction of its own.
export {
	InMemorySessionRepo,
	InMemorySessionStorage,
	JsonlSessionRepo,
} from '@earendil-works/pi-agent-core';
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { attentive, defineAgent, defineHuman, defineTool, passive, seated } from './define.ts';
// The room's own round: what a question opened, and what quiescence closed.
export type { ClosedExchange, Exchange } from './exchange.ts';
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
} from './types.ts';
export { isSpoken, isSummary } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
