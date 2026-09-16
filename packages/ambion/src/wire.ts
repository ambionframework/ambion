/**
 * What crosses between a seat and its room, and what the journal holds beside
 * a message. Every shape here is plain JSON:
 * an optional key is written only when it is present, and no value is
 * `undefined`, a `Date`, a `Map`, a `Set`, a class instance or a function. A
 * request and its response survive a round trip through `JSON.stringify`
 * unchanged, which is what lets a seat and a room live in two processes.
 *
 * The seat reaches the room through three calls: `view` reads what an
 * activation is given, `commit` puts one message on the record, and
 * `lease` claims, renews or releases the activation. The room reaches a
 * seat through three calls: `wake` starts an activation, `steer` sends
 * context to one running activation, and `cut` stops an activation whose
 * lease the room ended.
 */
import type { AgentSeatInfo, Attention, HumanSeatInfo, Message, Seq } from './types.ts';

/** The work authorized by the room, with the facts that purpose requires. */
export type ActivationPurpose =
	| { readonly kind: 'respond'; readonly message: Seq }
	| {
			readonly kind: 'summarize';
			readonly exchange: Seq;
			readonly person: string;
			readonly through: Seq;
	  };

/** The authority one recorded activation grants to its seat. */
export interface ActivationSpec {
	readonly id: string;
	readonly seat: string;
	readonly attempt: number;
	readonly purpose: ActivationPurpose;
}

// -- entries on the journal beside the messages -----------------------------------

/** `Omit` over each member of a union, so a discriminated body keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Why a lease ended: the activation ran to its end, it never reached the
 * record, the record kept moving past its drafts, the room wrote it off,
 * or it stopped renewing.
 */
export type EndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/**
 * One entry about an activation: it holds a lease, or its lease ended. The
 * last entry for an id wins, and an ended lease never runs again.
 */
export type LeaseChange =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: Seq }
	| { id: string; phase: 'ended'; reason: EndReason; at: string; readThrough: Seq };

/**
 * What the entries for one activation fold to: whether it runs, until when,
 * or why it ended, and where on the journal each fact landed. The journal
 * retains these entries, so replay reconstructs the same hold.
 */
type LeaseFact = {
	id: string;
	/** When the last entry was written, ISO. */
	at: string;
	/** When the first entry was written, ISO: the activation runs from here to its deadline. */
	claimedAt: string;
	/** The seq where this activation first attempted work. */
	since: Seq;
	/** The highest message position that the executor explicitly consumed. */
	readThrough: Seq;
};

export type LeaseHold =
	| (LeaseFact & {
			phase: 'running';
			/** When a running lease expires, in milliseconds since the epoch. */
			expiresAt: number;
	  })
	| (LeaseFact & {
			phase: 'ended';
			reason: EndReason;
			/** The seq when the end landed. */
			until: Seq;
	  });

/**
 * A run took the name: the first entry every run writes. The entry fences
 * the runs. The journal stamps the run on every entry beside the body, so
 * the fence body says only when the run took the name. An entry of an
 * earlier run that lands after a later run's fence is void.
 */
export interface Fence {
	at: string;
}

/** The room went quiet with an exchange open, and closed it. */
export interface Close {
	owner: string;
	from: Seq;
	through: Seq;
	at: string;
	/** The configured seated agent that writes a summary, when one is owed. */
	summary?: string;
}

/** One seat in a composition: its name, how the room knows it, and what wakes it. */
export interface Seating {
	name: string;
	identity: string;
	attention: Attention;
}

/**
 * What a run started with. The roster folds from the latest one, and a
 * reader without the definitions reads every identity off it.
 */
export interface Composition {
	version: 2;
	goal?: string;
	/** The configured agent that writes summaries for human owners. */
	summary?: string;
	agents: Seating[];
	available: Seating[];
	/**
	 * Where the composition sits on the record. The roster folds from here,
	 * the room writes it from the place the journal gives the entry.
	 */
	seq: Seq;
	at: string;
}

// -- the room reaching a seat -------------------------------------------------

/** A wake names an activation the seat runs. */
export interface Wake {
	room: string;
	seat: string;
	activation: string;
}

/** A message the room sends to one activation that is already running. */
export interface Steer {
	room: string;
	seat: string;
	/** The exact activation that was at work when the message landed. */
	activation: string;
	after: Seq;
	message: Message;
}

export interface SeatPort {
	wake(wake: Wake): Promise<void>;
	steer(steer: Steer): Promise<void>;
	/** The room ended this activation's lease: stop it, and run what queued behind it. */
	cut(activation: string): Promise<void>;
}

// -- a seat reaching its room -------------------------------------------------

/** Public participant facts with each person's recorded reading progress. */
export type ContextParticipant =
	| Omit<AgentSeatInfo, 'sessionId'>
	| (HumanSeatInfo & {
			readonly changedAt?: string;
			readonly since?: Seq;
			readonly unseen: number;
	  });

/** Collaboration facts selected for one activation. Private executable definitions stay with the executor. */
export interface CollaborationContext {
	readonly name: string;
	readonly now: number;
	readonly goal?: string;
	readonly participants: readonly ContextParticipant[];
	readonly messages: readonly Without<Message, 'preferences'>[];
	/** The open exchange for an ordinary response. */
	readonly exchange?: { readonly owner: string; readonly from: Seq };
	/** Reserve identities are available to every responding agent. */
	readonly reserve: readonly { readonly name: string; readonly identity: string }[];
	/** Only the summary writer reads the owner's preferences. */
	readonly preferences?: string;
}

export interface ActivationView {
	/** The identity and purpose authorized by the room. */
	spec: ActivationSpec;
	/** The context boundary represented by this view. Consumption acknowledges it. */
	through: Seq;
	context: CollaborationContext;
}

/** The request the lease answers is gone: the lease ended, or the room did. */
export interface Stale {
	stale: string;
}

export type ViewResponse = { view: ActivationView } | Stale;

/** What a seat asks the room to put on the record. The room stamps everything else. */
export type Intent =
	| { kind: 'said'; to?: string; text: string }
	| { kind: 'seated'; name: string }
	| { kind: 'unseated'; name: string };

export interface CommitRequest {
	activation: string;
	key: string;
	readThrough?: Seq;
	intent: Intent;
}

export type CommitResult =
	| { committed: Message }
	| { unchanged: { kind: 'seated' | 'unseated'; name: string } }
	| { missed: Message[] }
	| { refused: string }
	| Stale;

export type LeaseRequest =
	| { activation: string; operation: 'claim' }
	| { activation: string; operation: 'renew'; readThrough?: Seq }
	| { activation: string; operation: 'release'; reason: EndReason; readThrough: Seq };

/**
 * The lease holds, with its expiry and the last place on the record. The seat
 * reads `lastSeq` against what its view held: the record moved when it grew.
 * An entry beside the record moves neither, so a renewal never reports its
 * own landing as movement.
 */
export type LeaseResponse = { ok: { expiresAt: number; lastSeq: Seq } } | Stale;

export interface SeatRoom {
	view(activation: string): Promise<ViewResponse>;
	commit(commit: CommitRequest): Promise<CommitResult>;
	lease(lease: LeaseRequest): Promise<LeaseResponse>;
}

// -- checks --------------------------------------------------------------------

/** The value as it comes back from the wire. */
export function roundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const PLAIN = new Set(['Object', 'Array']);

/** Throws when a value would not survive the wire as it is. */
export function assertWire(value: unknown, path = '$'): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number.`);
		return;
	}
	if (typeof value !== 'object') throw new Error(`${path} is a ${typeof value}.`);
	const tag = (value as object).constructor?.name ?? 'Object';
	if (!PLAIN.has(tag)) throw new Error(`${path} is a ${tag}.`);
	for (const [key, item] of Object.entries(value as Record<string, unknown>))
		assertKey(item, `${path}.${key}`);
}

function assertKey(item: unknown, path: string): void {
	if (item === undefined) throw new Error(`${path} is undefined.`);
	assertWire(item, path);
}
