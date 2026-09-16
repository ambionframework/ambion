/**
 * The vocabulary: what a room is made of, as types.
 *
 * Every name here is one a host reads or writes — a message on the record, a
 * seat in the roster, an event on the stream, a definition it wrote itself.
 * Nothing in this file does anything; the files beside it are what happens.
 */

import type { Seq as RecordSeq } from '@ambionframework/journal';
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolExecutionMode,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { Static, TSchema } from 'typebox';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = RecordSeq;

/** A question the room is working on. */
export interface Exchange {
	/** The person whose question opened it, and who owns what follows. */
	readonly owner: string;
	/** The seq of that question: where the exchange starts. */
	readonly from: Seq;
	/** When it opened, ISO. */
	readonly at: string;
}

/** An exchange the room has finished, and the range it turned out to hold. */
export interface ClosedExchange extends Exchange {
	/** The last seq on the record when the room went quiet. */
	readonly through: Seq;
}

// -- what a host provides -----------------------------------------------------

/** The one clock a room reads, and the one alarm it sets. */
export interface Clock {
	/** Milliseconds since the epoch. */
	now(): number;
	/** Arrange one call of `fire` at `at`. Returns the cancel. */
	alarm(at: number, fire: () => void): () => void;
}

/** Resolves an agent's `provider/model-id` to the model Pi's loop runs. */
export type ModelResolver = (id: string, agent: string) => Model<Api> | Promise<Model<Api>>;

/** What a participant said. */
export interface SpokenMessage {
	kind: 'said';
	/** The place it took on the record. The journal gives it; a draft has none. */
	seq: Seq;
	/**
	 * The idempotency token the commit carried. The journal gives it. A host
	 * that never learned whether a delivery landed delivers it again under
	 * the same token, and the token lands once (`docs/durability.md` §2).
	 */
	key?: string;
	/** The activation that wrote it. Absent on a person's delivery. */
	activationId?: string;
	/** The seats the room decided to wake for it, written with the message. */
	wakes?: string[];
	/** ISO timestamp, stamped by the runtime at the moment it landed. */
	at: string;
	/** A participant's name — stamped by the runtime, never claimed. */
	from: string;
	/** Present when the delivery or say was directed. */
	to?: string;
	text: string;
}

/**
 * The four ways a participant's presence changes: a person arrives or leaves,
 * and an agent is seated or unseated while the room runs.
 */
export type PresenceChange = 'arrived' | 'left' | 'seated' | 'unseated';

/**
 * What happened to a participant. It carries no text, because they said
 * nothing: writing words under their name is what rule 7 exists to prevent.
 */
export interface PresenceMessage {
	kind: PresenceChange;
	seq: Seq;
	key?: string;
	/** The assistant's activation, on a `seated` it wrote. */
	activationId?: string;
	wakes?: string[];
	at: string;
	/**
	 * Who wrote it, the way every other kind reads `from`. A person writes
	 * their own arrival and their own departure. The assistant writes a
	 * seating it decided. A seating the host decided has no author: the host
	 * is not a participant, and nothing on the record speaks for it.
	 */
	from?: string;
	/**
	 * The participant whose presence changed: a person, stamped from the visit
	 * the runtime observed, or the agent the runtime seated or unseated. On an
	 * arrival and a departure it is the author, because a person's presence is
	 * theirs to change.
	 */
	subject: string;
	/**
	 * How the room knew them, on `arrived` and `seated`. Replay rebuilds the
	 * roster from the record, and a name without an identity is not a roster line.
	 */
	identity?: string;
	/** What wakes the seat, on `seated`. Absent means `broadcast`. */
	attention?: Attention;
	/** How the person reads, on `arrived`, when they said so. */
	preferences?: string;
}

/**
 * What one exchange came to. The assistant writes it. Nobody speaks it, so it is
 * not a `said`: a person did not hear it in a room.
 */
export interface SummaryMessage {
	kind: 'summary';
	seq: Seq;
	key?: string;
	activationId?: string;
	wakes?: string[];
	at: string;
	/** The assistant that wrote it. */
	from: string;
	/** The person whose question opened the exchange. Always present. */
	to: string;
	text: string;
	/** The range it stands for, ending at the last message before this one. */
	covers: { from: Seq; through: Seq };
}

/** One entry on a room's record. */
export type Message = SpokenMessage | PresenceMessage | SummaryMessage;

export function isSpoken(message: Message): message is SpokenMessage {
	return message.kind === 'said';
}

export function isSummary(message: Message): message is SummaryMessage {
	return message.kind === 'summary';
}

const PRESENCE_KINDS: ReadonlySet<string> = new Set<PresenceChange>([
	'arrived',
	'left',
	'seated',
	'unseated',
]);

export function isPresence(message: Message): message is PresenceMessage {
	return PRESENCE_KINDS.has(message.kind);
}

/** Whether a seat is taking an activation. Runtime state, not a seating choice. */
export type SeatStatus = 'active' | 'idle';

/** A collision-safe id for the Pi session that one seat owns in one room. */
export function seatSessionId(room: string, seat: string): string {
	return JSON.stringify(['ambion/seat-session', room, seat]);
}

/**
 * What wakes a seat, as the widest kind of message it activates for. One
 * widening scale, not a set of flags: `none` is woken by nothing said in the
 * room, `named` hears a message addressed to it, `broadcast` also hears
 * anything a participant said, and `presence` also hears somebody arriving or
 * leaving.
 *
 * `none` is the seat that is present and unreachable — the assistant, which
 * writes for the people in the room and wakes only when an exchange closes.
 * Widening it is what lets the assistant take part in the room like any other agent.
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
	/** Whether this ordinary seat is the room's designated assistant. */
	assistant: boolean;
	/** The id of the seat's downstream Pi session. */
	sessionId: string;
}

export interface HumanSeatInfo {
	kind: 'human';
	name: string;
	identity: string;
	presence: PresenceStatus;
}

export type SeatInfo = AgentSeatInfo | HumanSeatInfo;

/** The room's event stream: one notification per room-level fact. */
export type RoomNotification =
	/**
	 * A message landed on the record. Exactly one of these per message,
	 * whoever wrote it: what a person delivered, what an agent said, what the
	 * assistant wrote, and a person arriving or leaving all reach a host the same
	 * way.
	 */
	| { type: 'message'; message: Message }
	/**
	 * The room woke a seat. One per activation, however many requests to a
	 * provider it takes: an activation is the room's span, and Pi's own `turn`
	 * — one request and the tools it calls — never surfaces here.
	 */
	| { type: 'activation_start'; agent: string }
	/**
	 * The lock refused a message drafted against a record that had moved. It
	 * names the author rather than the seat: a seat's say and the assistant's summary
	 * are refused the same way, for the same reason.
	 */
	| { type: 'conflict'; author: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	/** The seat stopped, and `spoke` says whether it left a mark on the record. */
	| { type: 'activation_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	/**
	 * The room gave up: every attempt at a wake or a draft came to nothing,
	 * and the cap is reached. `activation` names the attempt the room did
	 * not make, and the journal holds the entry that says so.
	 */
	| { type: 'abandoned'; agent: string; activation: string }
	/**
	 * Another run took the name: its fence is on the journal past this run's.
	 * This run is superseded, and drops itself from memory the way
	 * `runtime.evict` does. Nothing it wrote after the other run's fence is on
	 * the record, and nothing it does from here on writes.
	 */
	| { type: 'superseded' }
	/**
	 * A person's question opened an exchange: the room has an exchange to work on,
	 * and one person owns it. A client that folds the working under the
	 * question it answered starts here, whatever the assistant makes of it
	 * later.
	 */
	| { type: 'exchange_opened'; exchange: Exchange }
	/**
	 * The room went quiet with an exchange open, so that exchange is over and
	 * holds the range it turned out to cover. It arrives after `settled` and
	 * before any summary: the assistant is the first reader of this, not the only
	 * one.
	 */
	| { type: 'exchange_closed'; exchange: ClosedExchange };

export const TOOL_BRAND = Symbol.for('ambion.tool');
/**
 * What a tool's `execute` is handed beside its parameters: the calling agent
 * and the abort signal Pi gives the tool call.
 */
export interface ToolContext {
	/** Stable identity of the agent making this tool call. */
	readonly agent: { readonly name: string; readonly identity: string };
	readonly signal?: AbortSignal;
	readonly callId: string;
	readonly onUpdate?: AgentToolUpdateCallback;
}

/** A composable set of tools and the guidance that explains their use. */
export interface ToolBundle {
	readonly tools: readonly unknown[];
	readonly guidance?: string;
}

/** A tool defined with Ambion's `defineTool` facade. */
export interface AmbionTool<TParameters extends TSchema = TSchema> {
	readonly [TOOL_BRAND]: true;
	readonly name: string;
	readonly description: string;
	readonly parameters: TParameters;
	readonly label?: string;
	readonly prepareArguments?: (args: unknown) => Static<TParameters>;
	readonly executionMode?: ToolExecutionMode;
	readonly execute: (
		params: Static<TParameters>,
		ctx: ToolContext,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

export interface AgentDefinition {
	readonly name: string;
	readonly identity: string;
	readonly instructions: string;
	readonly model: string;
	readonly tools: readonly unknown[];
	/** Guidance composed from the agent's tool bundles. */
	readonly guidance?: string;
}

export interface HumanDefinition {
	readonly name: string;
	readonly identity: string;
	/**
	 * How this person reads: what a message to them leads with, what to cut,
	 * and how much of one they take. The room's assistant reads it when it
	 * writes for them, and no other seat does.
	 */
	readonly preferences?: string;
}

export function isAmbionTool(t: unknown): t is AmbionTool {
	return typeof t === 'object' && t !== null && TOOL_BRAND in t;
}
