/**
 * The Ambion runtime: five primitives, and a dependency for every other concern.
 *
 * `defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
 * gives agents tools, `seated` chooses what wakes a seat — with
 * `passive` and `attentive` for the two points worth naming — and
 * `startSession` brings up a named room the agents work in and people visit.
 * A person's question opens an exchange, the room works, and quiescence
 * closes it — the exchange every other feature reads. `stopSession` takes
 * the room down, `readSession` reads a name without starting anything,
 * `visitSession` puts a person in a running room. The room's assistant composes the room at
 * the open of an exchange, from the agents held in reserve, and writes the
 * one message a person reads when the exchange closes. The design contracts
 * live in docs/agent.md, docs/exchange.md, docs/presence.md,
 * docs/assistant.md, docs/workspace.md and docs/roster.md.
 */

export type {
	DefineAgentOptions,
	DefineHumanOptions,
	DefineToolOptions,
	SeatingOptions,
} from './define.ts';
export { attentive, defineAgent, defineHuman, defineTool, passive, seated } from './define.ts';
export type { CreateRuntimeOptions, Runtime } from './host/runtime.ts';
export { createRuntime, defaultRuntime, systemClock } from './host/runtime.ts';
export type {
	ReadSessionOptions,
	ResumeSessionOptions,
	Session,
	SessionView,
	StartSessionOptions,
	Visit,
} from './session.ts';
export { readSession, resumeSession, startSession, stopSession, visitSession } from './session.ts';
export type {
	AgentDefinition,
	AgentSeat,
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
	ToolBundle,
	ToolContext,
} from './types.ts';
export { isPresence, isSeatedAgent, isSpoken, isSummary, seatSessionId } from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
