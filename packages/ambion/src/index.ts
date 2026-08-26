/**
 * The Ambion runtime: four primitives, one dependency that does the rest.
 *
 * `defineAgent` makes an agent, `defineHuman` seats a person, `defineTool`
 * gives agents hands, and `openSession` opens a named room where all of them
 * meet. The design contract lives in docs/agent.md.
 */

export type { SessionMetadata, SessionRepo, SessionStorage } from '@earendil-works/pi-agent-core';
// Storage is Pi's, re-exported — Ambion adds no storage abstraction of its own.
export { InMemorySessionRepo, InMemorySessionStorage } from '@earendil-works/pi-agent-core';
export type { DefineAgentOptions, DefineHumanOptions, DefineToolOptions } from './define.ts';
export { defineAgent, defineHuman, defineTool, passive } from './define.ts';
export type { Deliver, OpenSessionOptions, Session } from './session.ts';
export { openSession } from './session.ts';
export type {
	AgentDefinition,
	AmbionTool,
	HumanDefinition,
	Message,
	Participant,
	PassiveSeat,
	SeatInfo,
	SeatStatus,
	SessionEvent,
} from './types.ts';

/** Kept in step with package.json by a test. */
export const PACKAGE_NAME = '@ambionframework/ambion';
