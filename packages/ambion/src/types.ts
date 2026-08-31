/**
 * The vocabulary: what a room is made of, as types.
 *
 * Every name here is one a host reads or writes — a message on the record, a
 * seat in the roster, an event on the stream, a definition it wrote itself.
 * Nothing in this file does anything; the files beside it are what happens.
 */
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { Static, TSchema } from 'typebox';
import type { ClosedExchange, Exchange } from './exchange.ts';

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

/** The two ways a person's presence changes. */
export type PresenceChange = 'arrived' | 'left';

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

/**
 * What one exchange came to. An aide writes it. Nobody speaks it, so it is not
 * a `said`: a person did not hear it in a room.
 */
export interface SummaryMessage {
	kind: 'summary';
	seq: Seq;
	at: string;
	/** The aide that wrote it. */
	from: string;
	/** The person whose question opened the exchange. Always present. */
	to: string;
	text: string;
	/** The range it stands for, contiguous and ending just before this seq. */
	covers: { from: Seq; through: Seq };
}

/** One entry on a session's record. */
export type Message = SpokenMessage | PresenceMessage | SummaryMessage;

export function isSpoken(message: Message): message is SpokenMessage {
	return message.kind === 'said';
}

export function isSummary(message: Message): message is SummaryMessage {
	return message.kind === 'summary';
}

/** Whether a seat is taking a turn. Runtime state, not a seating choice. */
export type SeatStatus = 'active' | 'idle';

/**
 * What wakes a seat, as the widest kind of message it activates for. One
 * widening scale, not a set of flags: `none` is woken by nothing said in the
 * room, `named` hears a message addressed to it, `broadcast` also hears
 * anything a participant said, and `presence` also hears somebody arriving or
 * leaving.
 *
 * `none` is the seat that is present and unreachable — an aide, which writes
 * for one person and wakes only when their exchange closes. Widening it is
 * what lets an aide take part in the room like any other agent.
 */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** A person is in the room or they are not. */
export type PresenceStatus = 'present' | 'absent';

export interface AgentSeatInfo {
	kind: 'agent';
	name: string;
	identity: string;
	status: SeatStatus;
	attention: Attention;
	/** The id of the seat's downstream Pi session, `<room>:<agent>`. */
	sessionId: string;
	/** The person this seat writes for, when it is their aide. */
	owner?: string;
}

export interface HumanSeatInfo {
	kind: 'human';
	name: string;
	identity: string;
	presence: PresenceStatus;
	/** The name of the aide they brought, when they brought one. */
	aide?: string;
}

export type SeatInfo = AgentSeatInfo | HumanSeatInfo;

/** The session's event stream: room-level facts, one event per fact. */
export type SessionEvent =
	/**
	 * A message landed on the record. Exactly one of these per message,
	 * whoever wrote it: what a person delivered, what an agent said, what an
	 * aide wrote, and a person arriving or leaving all reach a host the same
	 * way.
	 */
	| { type: 'message'; message: Message }
	| { type: 'agent_start'; agent: string }
	/**
	 * The lock refused a message drafted against a record that had moved. It
	 * names the author rather than the seat: a seat's say and an aide's summary
	 * are refused the same way, for the same reason.
	 */
	| { type: 'conflict'; author: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	| { type: 'agent_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	/**
	 * A person's question opened an exchange: the room has a round to work on,
	 * and one person owns it. A client that folds the working under the
	 * question it answered starts here, whether or not anybody brought an aide.
	 */
	| { type: 'exchange_opened'; exchange: Exchange }
	/**
	 * The room went quiet with an exchange open, so that exchange is over and
	 * holds the range it turned out to cover. It arrives after `settled` and
	 * before any summary: an aide is the first reader of this, not the only
	 * one.
	 */
	| { type: 'exchange_closed'; exchange: ClosedExchange }
	/**
	 * Nothing is running: no seat is taking a turn, and no aide still owes a
	 * message. The room's own last word on a stretch of work.
	 *
	 * There is no event for the seats stopping. A host that wants the round is
	 * told by `exchange_closed`, which says whose it was and what it covered;
	 * a host that wants to act in the window before a summary lands waits on
	 * `settled()`, because that is a caller's concern rather than something
	 * that happened to the room.
	 */
	| { type: 'quiet' };

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
	/**
	 * The person's counterpart in a room: it holds their brief, writes the one
	 * message they read at the end of an exchange, and never speaks for them.
	 */
	readonly aide?: AgentDefinition;
}

/** An agent with its attention chosen, from `seated()` or its two shorthands. */
export interface SeatedAgent {
	readonly [SEAT_BRAND]: true;
	readonly agent: AgentDefinition;
	readonly attention: Attention;
}

/** What `startSession` seats: an agent on its own, or one with an attention. */
export type AgentSeat = AgentDefinition | SeatedAgent;

/** Who may be addressed by name. */
export type Participant = AgentDefinition | HumanDefinition;

export function isAgent(p: unknown): p is AgentDefinition {
	return typeof p === 'object' && p !== null && AGENT_BRAND in p;
}

export function isSeatedAgent(p: unknown): p is SeatedAgent {
	return typeof p === 'object' && p !== null && SEAT_BRAND in p;
}

export function isAmbionTool(t: unknown): t is AmbionTool {
	return typeof t === 'object' && t !== null && TOOL_BRAND in t;
}
