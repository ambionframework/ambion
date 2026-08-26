import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';

/** One entry on a session's record. `from`/`at` are stamped by the runtime. */
export interface Message {
	/** A participant's name — stamped by the runtime, never claimed. */
	from: string;
	/** Present when the delivery or say was directed. */
	to?: string;
	text: string;
	/** ISO timestamp, stamped by the runtime at the moment it landed. */
	at: string;
}

export type SeatStatus = 'active' | 'idle' | 'passive';

export interface SeatInfo {
	name: string;
	kind: 'agent' | 'human';
	identity: string;
	status: SeatStatus | 'human';
	/** Agents only: the id of the seat's downstream Pi session, `<room>:<agent>`. */
	sessionId?: string;
}

/** The session's event stream: Pi's event grammar, lifted to the room. */
export type SessionEvent =
	| { type: 'delivery'; message: Message }
	| { type: 'agent_start'; agent: string }
	| { type: 'say_start'; agent: string; to?: string }
	| { type: 'say_update'; agent: string; delta: string }
	| { type: 'say_end'; agent: string; message: Message }
	| { type: 'say_conflict'; agent: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	| { type: 'agent_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	| { type: 'settled' };

export const TOOL_BRAND = Symbol.for('ambion.tool');
export const AGENT_BRAND = Symbol.for('ambion.agent');
export const HUMAN_BRAND = Symbol.for('ambion.human');
export const SEAT_BRAND = Symbol.for('ambion.seat');

/** A tool defined with Ambion's `defineTool` facade. */
export interface AmbionTool<TParameters extends TSchema = TSchema> {
	readonly [TOOL_BRAND]: true;
	readonly name: string;
	readonly description: string;
	readonly parameters: TParameters;
	readonly execute: (
		params: Static<TParameters>,
		signal?: AbortSignal,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

export interface AgentDefinition {
	readonly [AGENT_BRAND]: true;
	readonly name: string;
	readonly identity: string;
	readonly instructions: string;
	readonly model: string;
	readonly tools: readonly unknown[];
}

export interface HumanDefinition {
	readonly [HUMAN_BRAND]: true;
	readonly name: string;
	readonly identity: string;
}

/** A seat marker produced by `passive(agent)`. */
export interface PassiveSeat {
	readonly [SEAT_BRAND]: true;
	readonly agent: AgentDefinition;
}

export type Participant = AgentDefinition | HumanDefinition | PassiveSeat;

export function isAgent(p: unknown): p is AgentDefinition {
	return typeof p === 'object' && p !== null && AGENT_BRAND in p;
}

export function isHuman(p: unknown): p is HumanDefinition {
	return typeof p === 'object' && p !== null && HUMAN_BRAND in p;
}

export function isPassiveSeat(p: unknown): p is PassiveSeat {
	return typeof p === 'object' && p !== null && SEAT_BRAND in p;
}

export function isAmbionTool(t: unknown): t is AmbionTool {
	return typeof t === 'object' && t !== null && TOOL_BRAND in t;
}
