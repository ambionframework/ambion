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
import type { TSchema } from 'typebox';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = RecordSeq;

/** `Omit` over each member of a union, so a discriminated body keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Why a lease ended. */
export type EndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** A question the room is working on. */
export interface ExchangeRef {
	/** The person whose question opened it, and who owns what follows. */
	readonly owner: string;
	/** The seq of that question: where the exchange starts. */
	readonly from: Seq;
	/** When it opened, ISO. */
	readonly at: string;
}

/** An exchange the room has finished, and the range it turned out to hold. */
export interface ClosedExchange extends ExchangeRef {
	/** The last seq on the record when the room went quiet. */
	readonly through: Seq;
}

/** The durable outcome of the optional summary assignment for a closed exchange. */
export type SummaryOutcome =
	| { readonly status: 'pending'; readonly writer?: string }
	| { readonly status: 'published'; readonly summary: SummaryMessage }
	| { readonly status: 'silent' }
	| { readonly status: 'failed' };

/** A detached exchange view that can be read without starting a room. */
export type ExchangeView =
	| (ExchangeRef & { readonly status: 'open' })
	| (ClosedExchange & { readonly status: 'closed'; readonly summary: SummaryOutcome });

interface RoomSnapshotFields {
	readonly name: string;
	readonly messages: readonly Message[];
	readonly participants: readonly ParticipantInfo[];
	readonly exchanges: readonly ExchangeView[];
	readonly exchange: Extract<ExchangeView, { readonly status: 'open' }> | undefined;
	/** The accepted journal sequence observed by this read. */
	readonly watermark: Seq;
}

/** A detached room read. Missing records have no room facts. */
export type RoomSnapshot =
	| (RoomSnapshotFields & {
			readonly initialized: false;
			readonly goal?: undefined;
			readonly messages: readonly [];
			readonly participants: readonly [];
			readonly exchanges: readonly [];
			readonly exchange: undefined;
	  })
	| (RoomSnapshotFields & {
			readonly initialized: true;
			readonly goal?: string;
	  });

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
	/** The activation that wrote this change, when an agent wrote it. */
	activationId?: string;
	wakes?: string[];
	at: string;
	/**
	 * Who wrote it, the way every other kind reads `from`. A person writes
	 * their own arrival and their own departure. An agent writes a
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
 * The assigned writer's closing contribution for one exchange. The room records
 * its `say` as a summary with a fixed recipient and source range.
 */
export interface SummaryMessage {
	kind: 'summary';
	seq: Seq;
	key?: string;
	activationId?: string;
	wakes?: string[];
	at: string;
	/** The agent that wrote it. */
	from: string;
	/** The person whose question opened the exchange. Always present. */
	to: string;
	text: string;
	/** The range it stands for, ending at the last message before this one. */
	covers: { from: Seq; through: Seq };
}

/** One entry on a room's record. */
export type Message = SpokenMessage | PresenceMessage | SummaryMessage;

/** Copy a recorded message before it crosses an ownership boundary. */
export function copyMessage<T extends Message>(message: T): T {
	return structuredClone(message);
}

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

/**
 * What wakes a seat, as the widest kind of message it activates for. One
 * widening scale, not a set of flags: `none` is woken by nothing said in the
 * room, `named` hears a message addressed to it, `broadcast` also hears
 * anything a participant said, and `presence` also hears somebody arriving or
 * leaving.
 *
 * `none` is the seat that is present and unreachable. Any configured agent may
 * use this attention when it should receive no ordinary messages.
 */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** A person is in the room or they are not. */
export type PresenceStatus = 'present' | 'absent';

export interface AgentParticipantInfo {
	kind: 'agent';
	name: string;
	identity: string;
	status: SeatStatus;
	attention: Attention;
}

export interface HumanParticipantInfo {
	kind: 'human';
	name: string;
	identity: string;
	presence: PresenceStatus;
}

export type ParticipantInfo = AgentParticipantInfo | HumanParticipantInfo;

/** The room's event stream: one notification per room-level fact. */
export type RoomNotification =
	/**
	 * A message landed on the record. Exactly one of these per message,
	 * whoever wrote it: what a person delivered, what an agent said, what the
	 * an agent wrote, and a person arriving or leaving all reach a host the same
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
	 * The lock refused ordinary speech because the record moved after its
	 * author read it. The event includes the messages the author missed.
	 */
	| { type: 'conflict'; author: string; missed: Message[] }
	| { type: 'tool_execution_start'; agent: string; toolName: string }
	| { type: 'tool_execution_end'; agent: string; toolName: string }
	/** The seat stopped, and `spoke` says whether it left a mark on the record. */
	| { type: 'activation_end'; agent: string; spoke: boolean }
	| { type: 'error'; agent: string; error: Error }
	/** A room delivery or seat call failed, or its result became unknown. */
	| {
			type: 'delivery_error';
			agent: string;
			activation: string;
			operation: 'wake' | 'steer' | 'cut' | 'view' | 'commit' | 'claim' | 'renew' | 'release';
			error: Error;
	  }
	/** Transcript persistence failed independently of the execution outcome. */
	| { type: 'audit_error'; agent: string; activation: string; error: Error }
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
	 * question it answered starts here, whatever the room makes of it
	 * later.
	 */
	| { type: 'exchange_opened'; exchange: ExchangeRef }
	/**
	 * The room went quiet with an exchange open, so that exchange is over and
	 * holds the range it turned out to cover. It arrives after `settled` and
	 * before any summary: the configured writer is one reader of this, not the only
	 * one.
	 */
	| { type: 'exchange_closed'; exchange: ClosedExchange };

/**
 * What a tool's `execute` is handed beside its parameters: the calling agent
 * and the abort signal Pi gives the tool call.
 */
export interface ToolContext {
	/** Stable identity of the agent making this tool call. */
	readonly agent: { readonly name: string; readonly identity: string };
	readonly signal?: AbortSignal;
	readonly callId: string;
	readonly onUpdate?: AgentToolUpdateCallback<unknown>;
}

/** A composable set of tools and the guidance that explains their use. */
export interface ToolBundle {
	readonly tools: readonly AmbionTool[];
	readonly guidance?: string;
}

/** One normalized tool definition used by the room executor. */
export interface AmbionTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: TSchema;
	readonly label: string;
	readonly prepareArguments?: (args: unknown) => unknown;
	readonly executionMode?: ToolExecutionMode;
	readonly invoke: (
		params: unknown,
		ctx: ToolContext,
	) => Promise<string | AgentToolResult<unknown>> | string | AgentToolResult<unknown>;
}

export interface AgentDefinition {
	readonly name: string;
	readonly identity: string;
	readonly instructions: string;
	readonly model: string;
	readonly tools: readonly AmbionTool[];
	/** Guidance composed from the agent's tool bundles. */
	readonly guidance?: string;
	/**
	 * The token budget for the record one activation reads. When set, the seat
	 * pages the record and keeps the newest part that fits the budget, plus the
	 * open exchange whole. Absent reads the whole record.
	 */
	readonly tokenBudget?: number;
	/**
	 * How the agent counts tokens against its budget. Absent uses a length
	 * estimate. The seat runs it, so it never crosses the wire.
	 */
	readonly estimateTokens?: (text: string) => number;
}

export interface HumanDefinition {
	readonly name: string;
	readonly identity: string;
	/**
	 * How this person reads: what a message to them leads with, what to cut,
	 * and how much of one they take. The configured summary writer reads it when
	 * it writes for them, and no other seat does.
	 */
	readonly preferences?: string;
}
