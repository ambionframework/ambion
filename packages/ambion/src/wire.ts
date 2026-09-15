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
 * seat through two: `wake` names an activation the seat runs, and carries
 * the line a running activation is steered with when a message caused it;
 * `cut` names an activation whose lease the room ended, so the seat side
 * stops it now.
 */
import type { Attention, Message, Seq } from './types.ts';

type ActivationIdentity = { readonly id: string; readonly seat: string; readonly attempt: number };
type ActivationOpening = { readonly person: string; readonly from: Seq; readonly limit: number };
type ActivationClosing = { readonly person: string; readonly from: Seq; readonly through: Seq };

/** The authority a room grants to a recorded activation. */
export type ActivationSpec =
	| (ActivationIdentity & {
			readonly cause: 'message';
			readonly through: Seq;
			readonly grant: { readonly kind: 'say'; readonly tool: 'say' };
	  })
	| (ActivationIdentity & {
			readonly cause: 'opened';
			readonly through: Seq;
			readonly opening: ActivationOpening;
			readonly grant: { readonly kind: 'seat'; readonly tool: 'seat' };
	  })
	| (ActivationIdentity & {
			readonly cause: 'closed';
			readonly through: Seq;
			readonly closing: ActivationClosing;
			readonly grant: { readonly kind: 'summary'; readonly tool: 'summarise' };
	  });

// -- entries on the journal beside the messages -----------------------------------

/** `Omit` over each member of a union, so a discriminated body keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Why a lease ended: the activation ran to its end, it never reached the
 * record, the record kept moving past its drafts, the room wrote it off,
 * or it stopped renewing.
 */
export type EndReason = 'released' | 'failed' | 'refused' | 'revoked' | 'expired' | 'abandoned';

/**
 * One entry about an activation: it holds a lease, or its lease ended. The
 * last entry for an id wins, and an ended lease never runs again.
 */
export type LeaseChange =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: Seq }
	| { id: string; phase: 'ended'; reason: EndReason; at: string; readThrough: Seq };

/**
 * What the entries for one activation fold to: whether it runs, until when,
 * or why it ended, and where on the journal each fact landed. A checkpoint
 * carries these in place of the entries that made them, so the shape crosses
 * the wire.
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

/**
 * The room as it stood, in one entry. A fold reads a checkpoint as the
 * composition, the closes and the leases it carries, and nothing older; a
 * wake on a message below `floor` was answered when the checkpoint was
 * written. A checkpoint is a cache over the journal: the entries it replaces
 * stay on the storage, and a checkpoint the room cannot read is ignored.
 */
export interface Checkpoint {
	/** The shape of this entry. A checkpoint of another shape is ignored. */
	v: 2;
	/** No wake on a message before this seq is pending. */
	floor: Seq;
	composition: Composition;
	closes: Close[];
	leases: LeaseHold[];
	at: string;
}

/** Whether a body read off the journal is a checkpoint this room can fold. */
export function isCheckpoint(body: unknown): body is Checkpoint {
	if (typeof body !== 'object' || body === null) return false;
	const candidate = body as Partial<Checkpoint>;
	return (
		candidate.v === 2 &&
		typeof candidate.floor === 'number' &&
		typeof candidate.composition === 'object' &&
		candidate.composition !== null &&
		Array.isArray(candidate.closes) &&
		Array.isArray(candidate.leases)
	);
}

/** The room went quiet with an exchange open, and closed it. */
export interface Close {
	owner: string;
	from: Seq;
	through: Seq;
	at: string;
	/** The assistant seat that writes a summary when the exchange owes one. */
	wakes?: string[];
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
	goal?: string;
	/** The agent that performs the room's assistant work, when the room seats one. */
	assistant?: string;
	agents: Seating[];
	available: Seating[];
	/**
	 * Where the composition sits on the record. The roster folds from here,
	 * so a checkpoint that carries a composition carries this with it, and
	 * the room writes it from the place the journal gives the entry.
	 */
	seq: Seq;
	at: string;
}

// -- the room reaching a seat -------------------------------------------------

/**
 * A wake names the activation the seat runs for it. When a message caused
 * it, `steer` carries the line a running activation is handed instead of a
 * fresh start: the seat side reads it only while an activation runs.
 */
export interface Wake {
	room: string;
	seat: string;
	activation: string;
	steer?: { after: Seq; seq: Seq; line: string };
}

export interface SeatPort {
	wake(wake: Wake): Promise<void>;
	/** The room ended this activation's lease: stop it, and run what queued behind it. */
	cut(activation: string): Promise<void>;
}

// -- a seat reaching its room -------------------------------------------------

export interface ActivationView {
	/** The recorded activation and the boundary its input reads through. */
	spec: ActivationSpec;
	/** The agent's `provider/model-id`, resolved on the seat side. */
	model: string;
	systemPrompt: string;
	context: string;
}

/** The request the lease answers is gone: the lease ended, or the room did. */
export interface Stale {
	stale: string;
}

export type ViewResponse = { view: ActivationView } | Stale;

/** What a seat asks the room to put on the record. The room stamps everything else. */
export type Intent =
	| { kind: 'said'; to?: string; text: string }
	| { kind: 'summary'; to: string; text: string; covers: { from: Seq; through: Seq } }
	| { kind: 'seated'; name: string };

export interface CommitRequest {
	activation: string;
	key: string;
	readThrough?: Seq;
	intent: Intent;
}

export type CommitResult =
	{ committed: Message } | { missed: Message[] } | { refused: string } | Stale;

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
