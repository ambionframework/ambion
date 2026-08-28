import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = number;

/** What a participant said. */
export interface SpokenMessage {
	kind: 'said';
	seq: Seq;
	/** ISO timestamp, stamped by the runtime at the moment it landed. */
	at: string;
	/** A participant's name — stamped by the runtime, never claimed. */
	from: string;
	/** Present when the delivery or say was directed. */
	to?: string;
	text: string;
}

/** The four ways a person's presence changes. */
export type PresenceChange = 'arrived' | 'away' | 'returned' | 'left';

/**
 * What a person did. It carries no text, because they said nothing: writing
 * words under their name is what rule 7 exists to prevent.
 */
export interface PresenceMessage {
	kind: PresenceChange;
	seq: Seq;
	at: string;
	/** The person, stamped from the visit the runtime observed. */
	from: string;
	/**
	 * How the room knew them, on `arrived` alone. Replay rebuilds the roster
	 * from the record, and a name without an identity is not a roster line.
	 */
	identity?: string;
}

/** One entry on a session's record. */
export type Message = SpokenMessage | PresenceMessage;

export function isSpoken(message: Message): message is SpokenMessage {
	return message.kind === 'said';
}

export type SeatStatus = 'active' | 'idle' | 'passive';

/** A visit is present or away. A person is also absent when they hold none. */
export type VisitStatus = 'present' | 'away';
export type PresenceStatus = VisitStatus | 'absent';

export interface AgentSeatInfo {
	kind: 'agent';
	name: string;
	identity: string;
	status: SeatStatus;
	/** The id of the seat's downstream Pi session, `<room>:<agent>`. */
	sessionId: string;
}

export interface HumanSeatInfo {
	kind: 'human';
	name: string;
	identity: string;
	presence: PresenceStatus;
	/** How many live visits hold this seat. */
	visits: number;
}

export type SeatInfo = AgentSeatInfo | HumanSeatInfo;

export interface VisitInfo {
	id: string;
	human: string;
	status: VisitStatus;
	via?: string;
	/** ISO, stamped by the runtime. */
	enteredAt: string;
	/** ISO, stamped by the runtime. */
	lastActedAt: string;
	/** Where this person stopped reading last, or undefined when they never have. */
	since: Seq | undefined;
}

/** The session's event stream: room-level facts, one event per fact. */
export type SessionEvent =
	| { type: 'delivery'; message: Message }
	| { type: 'agent_start'; agent: string }
	| { type: 'say'; agent: string; message: SpokenMessage }
	| { type: 'say_conflict'; agent: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	| { type: 'agent_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	| { type: 'settled' }
	| { type: 'visit_enter'; human: string; visit: string; presence: PresenceStatus }
	| { type: 'visit_away'; human: string; visit: string; presence: PresenceStatus }
	| { type: 'visit_return'; human: string; visit: string; presence: PresenceStatus }
	| { type: 'visit_leave'; human: string; visit: string; presence: PresenceStatus };

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

/** What `startSession` seats: an agent, idle or passive. */
export type AgentSeat = AgentDefinition | PassiveSeat;

/** Who may be addressed by name. */
export type Participant = AgentDefinition | HumanDefinition;

export function isAgent(p: unknown): p is AgentDefinition {
	return typeof p === 'object' && p !== null && AGENT_BRAND in p;
}

export function isPassiveSeat(p: unknown): p is PassiveSeat {
	return typeof p === 'object' && p !== null && SEAT_BRAND in p;
}

export function isAmbionTool(t: unknown): t is AmbionTool {
	return typeof t === 'object' && t !== null && TOOL_BRAND in t;
}
