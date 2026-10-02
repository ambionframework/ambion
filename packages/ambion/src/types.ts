/**
 * The vocabulary: what a room is made of, as types.
 *
 * Every name here is one a host reads or writes — a message on the record, a
 * seat in the roster, an event on the stream, a definition it wrote itself.
 * Nothing in this file does anything; the files beside it are what happens.
 */

import type { Seq as RecordSeq } from '@ambionframework/journal';
import type { Static } from 'typebox';
import type {
	attentionSchema,
	dismissedSchema,
	endReasonSchema,
	failureCauseSchema,
	postedSchema,
	presenceChangeSchema,
	presenceSchema,
	saidSchema,
	summarySchema,
	usageSchema,
	vendorSessionSchema,
} from './bodies.ts';
import type { AmbionTool, Reminder } from './bundle.ts';
import type { ScheduledSay } from './scheduling.ts';
import type { SessionFacts } from './session-facts.ts';

/** A position on the record: monotonic, assigned at commit, never reused. */
export type Seq = RecordSeq;
/** `Omit` over each member of a union, so a discriminated body keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Why a lease ended. */
export type EndReason = Static<typeof endReasonSchema>;

/**
 * Why an activation failed. A permanent failure does not pass on a retry, so
 * the room abandons it at once. A transient failure may pass, so the room
 * retries it to the cap. An authentication, a bad request, a spent credit,
 * quota or usage limit, and a fault in the configuration are permanent. A
 * rate limit, a server error, or a lost connection is transient.
 */
export type FailureCause = Static<typeof failureCauseSchema>;

/** What a seat asks the room to record. The room stamps everything else. */
export type Intent =
	| { kind: 'said'; to?: string; text: string; refs?: string[]; delaySeconds?: number }
	| { kind: 'seated'; name: string }
	| { kind: 'unseated'; name: string }
	| { kind: 'dismissed'; message: Seq };

/** The work the room is on, from the message that opened it. */
export interface ExchangeRef {
	/**
	 * The person the result goes to: the first person who spoke in the
	 * range. Absent until a person speaks, as in the work of a returned say.
	 */
	readonly person?: string;
	/** The seq of the message that opened it: where the exchange starts. */
	readonly from: Seq;
	/** When it opened, ISO. */
	readonly at: string;
}

/** An exchange the room has finished, and the range it turned out to hold. */
export interface ExchangeRange extends ExchangeRef {
	/** The last seq on the record when the room went quiet. */
	readonly through: Seq;
}

/** The durable outcome of the optional summary work for a closed exchange. */
export type SummaryOutcome =
	| { readonly kind: 'pending'; readonly writer?: string }
	| { readonly kind: 'published'; readonly summary: SummaryMessage }
	| { readonly kind: 'silent' }
	| { readonly kind: 'failed' };

/** How an activation stands: at work, or ended for a reason. */
export type ActivationOutcome =
	| { readonly kind: 'running' }
	| {
			readonly kind: EndReason;
			/** Set when a cancellation ended the activation. */
			readonly cancelled?: true;
			/** Why the activation failed, on a failed or abandoned activation. */
			readonly cause?: FailureCause;
	  };

/** One activation of an exchange, as `Exchange` lists it. */
export interface ExchangeActivation {
	/** The activation id. */
	readonly id: string;
	readonly seat: string;
	/** The attempt number. A retry is a new attempt of one due activation. */
	readonly attempt: number;
	/** `respond` answers a message. `summarize` writes the closing summary. */
	readonly purpose: 'respond' | 'summarize';
	readonly outcome: ActivationOutcome;
	/** What the activation spent, once it ended and recorded usage. */
	readonly usage?: Usage;
	readonly session?: VendorSession;
}

/**
 * How a closed exchange ended. The room derives it from the record.
 * `cancelled` beats `exhausted`, `exhausted` beats `awaiting`, and
 * `awaiting` beats `complete`.
 */
export type ExchangeOutcome =
	| { readonly kind: 'complete' }
	/** A cancellation wrote the close. */
	| { readonly kind: 'cancelled' }
	/** The room gave up on a respond activation in the range. */
	| { readonly kind: 'exhausted' }
	/** The last said message is directed at a person who has said nothing since. */
	| { readonly kind: 'awaiting'; readonly person: string };

/** A detached exchange, open or closed, that a host reads without starting a room. */
export type Exchange =
	| (ExchangeRef & {
			readonly status: 'open';
			/** Every activation since the exchange opened, in journal order. */
			readonly activations: readonly ExchangeActivation[];
	  })
	| (ExchangeRange & {
			readonly status: 'closed';
			/** Every activation in the range, every attempt and the summary included. */
			readonly activations: readonly ExchangeActivation[];
			readonly summary: SummaryOutcome;
			readonly outcome: ExchangeOutcome;
			/** Every published summary of the range, one for each recipient, `person` first. */
			readonly summaries?: readonly SummaryMessage[];
			/** The sum of every activation in the range, the summary activation included. */
			readonly usage?: Usage;
	  });

interface RoomReadFields {
	readonly name: string;
	readonly messages: readonly Message[];
	/** The scheduled says that wait to return, in the order they landed. */
	readonly scheduled: readonly ScheduledSay[];
	readonly participants: readonly Participant[];
	/** The agents on the record that no seat holds now. A seat takes one by name. */
	readonly reserve: readonly { readonly name: string; readonly identity: string }[];
	readonly exchanges: readonly Exchange[];
	readonly exchange: Extract<Exchange, { readonly status: 'open' }> | undefined;
	/** The accepted journal sequence observed by this read. */
	readonly through: Seq;
}

/** A detached room read. Missing records have no room facts. */
export type RoomRead =
	| (RoomReadFields & {
			readonly initialized: false;
			readonly goal?: undefined;
			readonly messages: readonly [];
			readonly scheduled: readonly [];
			readonly participants: readonly [];
			readonly reserve: readonly [];
			readonly exchanges: readonly [];
			readonly exchange: undefined;
	  })
	| (RoomReadFields & {
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

/** What every message carries once the journal has placed it. */
interface Landed {
	/** The place it took on the record. The journal gives it; a draft has none. */
	seq: Seq;
	/**
	 * The idempotency token the commit carried. The journal gives it. A host
	 * that never learned whether a delivery landed delivers it again under
	 * the same token, and the token lands once (`docs/durability.md` §2).
	 */
	key?: string;
}

/** What a participant said. */
export interface SaidMessage extends Landed, Static<typeof saidSchema> {}

/**
 * A message of the system: the host posted it, or the room's clock returned a
 * scheduled say. It has no author, and the room is not a participant. When no
 * exchange is open, it opens one, as a person's question does.
 */
export interface PostedMessage extends Landed, Static<typeof postedSchema> {
	/** The system wrote it, so it has no author. */
	from?: undefined;
}

/**
 * The four ways a participant's presence changes: a person arrives or leaves,
 * and an agent is seated or unseated while the room runs.
 */
export type PresenceChange = Static<typeof presenceChangeSchema>;

/**
 * What happened to a participant. It carries no text, because they said
 * nothing: writing words under their name is what `say` prevents: an author writes only under their own name.
 */
export interface PresenceMessage extends Landed, Static<typeof presenceSchema> {}

/**
 * The assigned writer's closing contribution for one exchange. The room records
 * its `say` as a summary with a fixed recipient and source range.
 */
export interface SummaryMessage extends Landed, Static<typeof summarySchema> {}

/**
 * A seat or the host dismissed a scheduled say that waited to return. The
 * room returns it no more. A dismissal by the host has no author.
 */
export interface DismissedMessage extends Landed, Static<typeof dismissedSchema> {}

/** One entry on a room's record. */
export type Message =
	SaidMessage | PresenceMessage | SummaryMessage | PostedMessage | DismissedMessage;

/** Copy a recorded message before it crosses an ownership boundary. */
export function copyMessage<T extends Message>(message: T): T {
	return structuredClone(message);
}

export function isSaid(message: Message): message is SaidMessage {
	return message.kind === 'said';
}

export function isPosted(message: Message): message is PostedMessage {
	return message.kind === 'posted';
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
export type Attention = Static<typeof attentionSchema>;

/** How a seat wakes, and whether an agent can unseat it. */
export interface SeatOptions {
	attention?: Attention;
	/**
	 * An agent cannot unseat this seat; the host always can. Absent, the
	 * summary writer's seat is fixed and every other seat is not.
	 */
	fixed?: boolean;
}

/** A person is in the room or they are not. */
export type PresenceStatus = 'present' | 'absent';

export interface AgentParticipant {
	kind: 'agent';
	name: string;
	identity: string;
	status: SeatStatus;
	attention: Attention;
}

export interface PersonParticipant {
	kind: 'person';
	name: string;
	identity: string;
	presence: PresenceStatus;
}

export type Participant = AgentParticipant | PersonParticipant;

/** A room-level fact: what landed on the record, or what happened to this run. */
export type RoomEvent =
	/**
	 * A message landed on the record. Exactly one of these per message,
	 * whoever wrote it: what a person delivered, what an agent said, what an
	 * agent wrote, and a person arriving or leaving all reach a host the same
	 * way.
	 */
	| { type: 'message'; message: Message }
	/**
	 * Another run took the name: its fence is on the journal past this run's.
	 * This run is superseded, and drops itself from memory the way
	 * `hostingOf(runtime).evict` does. Nothing it wrote after the other run's
	 * fence is on the record, and nothing it does from here on writes.
	 */
	| { type: 'superseded' }
	/**
	 * A person's question opened an exchange: the room has an exchange to work on,
	 * and its `person` is the first who spoke. A client that folds the working
	 * under the question it answered starts here, whatever the room makes of it
	 * later.
	 */
	| { type: 'exchange_opened'; exchange: ExchangeRef }
	/**
	 * The room went quiet with an exchange open, so that exchange is over and
	 * holds the range it turned out to cover. It arrives before any summary:
	 * the configured writer is one reader of this, not the only one.
	 */
	| { type: 'exchange_closed'; exchange: ExchangeRange };

/** What one activation did, or what happened to it. Every member names the activation. */
export type ActivationEvent =
	/**
	 * The room woke a seat. One per activation, however many requests to a
	 * provider it takes: an activation is the room's span, and Pi's own `turn`
	 * — one request and the tools it calls — never surfaces here.
	 */
	| { type: 'activation_start'; seat: string; activation: string }
	/**
	 * The lock refused ordinary speech because the record moved after its
	 * author read it. The event includes the messages the author missed.
	 */
	| { type: 'conflict'; seat: string; activation: string; missed: Message[] }
	| { type: 'tool_call'; seat: string; activation: string; name: string }
	| { type: 'tool_result'; seat: string; activation: string; name: string }
	/** The seat stopped, and `said` says whether it left a mark on the record. */
	| {
			type: 'activation_end';
			seat: string;
			activation: string;
			said: boolean;
			/** What the activation spent. Absent when it reached no provider or the room ended it. */
			usage?: Usage;
	  }
	| { type: 'error'; seat: string; activation: string; error: Error; cause?: FailureCause }
	/** A room delivery or seat call failed, or its result became unknown. */
	| {
			type: 'port_error';
			seat: string;
			activation: string;
			operation: 'wake' | 'steer' | 'cut' | 'view' | 'commit' | 'claim' | 'renew' | 'release';
			error: Error;
	  }
	/**
	 * The room gave up: a permanent failure, or every attempt of a due
	 * activation came to nothing and the cap is reached. `activation` names the
	 * attempt the room did not make, `cause` says why, and the journal holds
	 * the entry that says so.
	 */
	| { type: 'abandoned'; seat: string; activation: string; cause: FailureCause };

// -- steps --------------------------------------------------------------------

/**
 * What an activation spent, or the sum of what activations spent. `cost` is
 * present when at least one contributing step carried it.
 */
export interface Usage extends Static<typeof usageSchema> {}

/** A vendor session that an ended activation recorded. The room never reads the id. */
export type VendorSession = Static<typeof vendorSessionSchema>;

/** Two totals added. `cost` stays absent until a step carries it. */
export function addUsage(total: Usage | undefined, step: Usage): Usage {
	const cost =
		total?.cost === undefined && step.cost === undefined
			? undefined
			: (total?.cost ?? 0) + (step.cost ?? 0);
	return {
		input: (total?.input ?? 0) + step.input,
		output: (total?.output ?? 0) + step.output,
		cacheRead: (total?.cacheRead ?? 0) + step.cacheRead,
		cacheWrite: (total?.cacheWrite ?? 0) + step.cacheWrite,
		...(cost === undefined ? {} : { cost }),
	};
}

/**
 * One thing an activation did, in a vocabulary every executor kind shares.
 * The trace gives each step to the host's logger once. A step is plain JSON.
 */
export type Step =
	/** A pass begins. `view` reads the whole record; `delta` follows a record that moved. */
	| { type: 'pass'; pass: number; input: 'view' | 'delta'; through: Seq }
	/** A block of the model's reasoning. `final` closes the block. */
	| { type: 'thinking'; text: string; final: boolean }
	/** A block of the model's text. `final` closes the block. */
	| { type: 'text'; text: string; final: boolean }
	/** `parent` names the `compose` call that made a nested call. A direct call has none. */
	| { type: 'tool_call'; call: string; name: string; input: unknown; parent?: string }
	| { type: 'tool_result'; call: string; output: unknown; error?: string; parent?: string }
	/** The answer to the approval of one compose call. `call` names the compose call. */
	| { type: 'approval'; call: string; answer: 'allow' | 'deny' }
	/** What the room answered to a commit the seat made. */
	| {
			type: 'room';
			call: string;
			intent: Intent;
			result: 'committed' | 'unchanged' | 'missed' | 'refused' | 'stale' | 'unknown';
			seq?: Seq;
	  }
	/** A message landed mid-activation. `consumed` says whether the model received it in that pass. */
	| { type: 'steer'; seq: Seq; consumed: boolean }
	| ({ type: 'usage' } & Usage)
	/** What the harness ran with, as it reported at the start of a session. */
	| ({ type: 'session' } & SessionFacts)
	/** A non-fatal diagnostic from the harness. A notice never gates the activation. */
	| { type: 'notice'; level: 'info' | 'warning'; text: string; data?: Record<string, unknown> }
	/** The activation stops. `failure` is present when it failed. */
	| {
			type: 'end';
			stop: 'stopped' | 'length' | 'cut';
			failure?: { cause: FailureCause; message: string };
	  };

/** A step as the trace logs it: stamped with where and when it happened. */
export type TraceStep = Step & {
	readonly activation: string;
	readonly pass: number;
	/** ISO timestamp from the runtime clock. */
	readonly at: string;
	/** The place in the pass, from zero. One counter per pass. */
	readonly index: number;
};

/** One step of one activation, as the trace gives it to the host's logger. */
export interface TracedStep {
	/** The room the activation ran in. */
	readonly room: string;
	/** The seat that ran the activation. */
	readonly seat: string;
	/** The step, stamped with `activation`, `pass`, `index` and `at`. */
	readonly step: TraceStep;
}

/**
 * Where the steps of each activation go. The host passes one in. The trace
 * calls it once for each step, in order, on the path of the activation, so
 * it must not block. A logger that throws or rejects changes nothing.
 */
export type TraceLogger = (traced: TracedStep) => void;

/** What the trace keeps of an agent's work. */
export interface TracePolicy {
	/** `start` keeps the start of each block. */
	readonly thinking: 'omit' | 'start' | 'full';
	readonly toolOutput: 'omit' | 'full';
}

/** The room's event stream: room facts and activation events, under one `subscribe`. */
export type RoomNotification = RoomEvent | ActivationEvent;

/**
 * What an agent runs on: an executor kind, instructions, and tools. The room
 * reads the fields below and no other. An executor kind adds its own
 * fields, such as a model, and reads them itself.
 */
export interface Executor {
	/** The executor kind, such as `pi`. The host that composes execution resolves it. */
	readonly kind: string;
	readonly instructions: string;
	readonly tools: readonly AmbionTool[];
	/** Guidance composed from the agent's tool bundles. */
	readonly guidance?: string;
	/** The reminders of the agent's tool bundles, in bundle order. */
	readonly reminders?: readonly Reminder[];
	/** The speaking policy. It replaces `DEFAULT_SPEAKING`. Absent uses the default. */
	readonly speaking?: string;
	/**
	 * The token limit for the record one activation reads. When set, the room
	 * keeps the newest part of the record that fits the limit, plus the open
	 * exchange whole. Absent reads the whole record.
	 */
	readonly activationTokenLimit?: number;
	/**
	 * The name of the estimator that counts tokens against the limit. The room
	 * runs the estimator from the registry of its runtime, so the definition
	 * carries the name alone. Absent names `length`.
	 */
	readonly estimateTokens?: string;
}

export interface AgentDefinition {
	readonly name: string;
	readonly identity: string;
	readonly executor: Executor;
	/** What the trace keeps. `defineAgent` and `captureAgent` set the default when absent. */
	readonly trace?: TracePolicy;
}

export interface PersonDefinition {
	readonly name: string;
	readonly identity: string;
	/**
	 * How this person reads: what a message to them leads with, what to cut,
	 * and how much of one they take. The configured summary writer reads it when
	 * it writes for them, and no other seat does.
	 */
	readonly preferences?: string;
}
