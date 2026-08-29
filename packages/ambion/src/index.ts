/**
 * The Ambion runtime: four primitives, one dependency that does the rest.
 *
 * `defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
 * gives agents hands, and `startSession` brings up a named room the agents
 * work in and people visit. `stopSession` takes it down, `readSession` reads
 * a name without starting anything, and `visitSession` puts a person in a
 * running room. The design contracts live in docs/agent.md and
 * docs/presence.md.
 */

export type { SessionMetadata, SessionRepo, SessionStorage } from '@earendil-works/pi-agent-core';
// Storage is Pi's, re-exported — Ambion adds no storage abstraction of its own.
export {
	InMemorySessionRepo,
	InMemorySessionStorage,
	JsonlSessionRepo,
} from '@earendil-works/pi-agent-core';
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { attentive, defineAgent, defineHuman, defineTool, passive } from './define.ts';
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
} from './types.ts';
export { isSpoken } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
