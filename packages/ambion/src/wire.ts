/**
 * What crosses between a seat and its room, and what the log holds beside
 * a message. Every shape here is plain JSON: an optional key is written
 * only when it is present, and no value is `undefined`, a `Date`, a `Map`,
 * a `Set`, a class instance or a function. A request and its response
 * survive a round trip through `JSON.stringify` unchanged, which is what
 * lets a seat and a room live in two processes.
 *
 * The seat reaches the room through three calls: `view` reads what an
 * activation is given, `commit` puts one message on the record, and
 * `lease` claims, renews or releases the activation. The room reaches a
 * seat through two: `wake` names a message the seat has to hear, and the
 * seat side decides whether that starts an activation or steers the one
 * that runs; `cut` names an activation whose lease the room ended, so the
 * seat side stops it now.
 */
import type { Attention, Message, Seq } from './types.ts';

// -- rows on the log beside the messages --------------------------------------

/** `Omit` over each member of a union, so a discriminated row keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Why a lease ended. `abandoned` ends an attempt the room never made: the
 * wake or the draft reached the cap, and the row says so.
 */
export type EndReason = 'released' | 'failed' | 'refused' | 'revoked' | 'expired' | 'abandoned';

/**
 * One row about an activation: it holds a lease, or its lease ended. Where
 * the row sits on the log says what the activation heard: `after` is the
 * last seq when the row landed.
 */
export type LeaseRow =
	| { id: string; after: Seq; phase: 'running'; expiry: number; at: string }
	| { id: string; after: Seq; phase: 'ended'; reason: EndReason; at: string };

/**
 * A lease as the fold holds it, and what a checkpoint carries in place of
 * the lease's rows: the rows' positions are lost with the rows, so the
 * checkpoint keeps what they said.
 */
export interface LeaseSnapshot {
	id: string;
	phase: 'running' | 'ended';
	/** When a running lease expires, in milliseconds since the epoch. */
	expiry?: number;
	reason?: EndReason;
	/** When the last row was written, ISO. */
	at: string;
	/** When the first row was written, ISO: when the activation claimed. The deadline counts from here. */
	claimedAt: string;
	/** The last seq when the first row landed: the activation's view held the record through here. */
	since: Seq;
	/** The last seq when the ended row landed, for an ended lease. */
	until?: Seq;
	/** The last seq when the last running row landed: the activation confirmed it heard through here. */
	heardThrough: Seq;
}

/**
 * A run took the name: the first row every run writes. The row is the
 * fence between runs. Every entry a run writes carries its `run`, and an
 * entry of an earlier run that lands after a later run's row is void.
 */
export interface RunRow {
	run: string;
	after: Seq;
	at: string;
}

/** The room went quiet with an exchange open, and closed it. */
export interface CloseRow {
	owner: string;
	from: Seq;
	through: Seq;
	after: Seq;
	at: string;
	/** The assistant, when the exchange owes a summary. */
	wakes?: string[];
}

/** One seat in a composition: its name and what wakes it. */
export interface SeatRow {
	name: string;
	identity: string;
	attention: Attention;
}

/**
 * What a run started with. The roster folds from the latest one, and a
 * reader without the definitions reads every identity off it.
 */
export interface CompositionRow {
	/** The assistant's seat. Its attention is `none`. */
	assistant: SeatRow;
	goal?: string;
	agents: SeatRow[];
	available: SeatRow[];
	after: Seq;
	at: string;
}

/**
 * The rows that still matter, in place of every row before this one. The
 * fold reads a checkpoint as the composition, the closes and the leases it
 * carries, and nothing older; a wake on a message below `floor` was
 * answered when the checkpoint was written. A checkpoint is a cache over
 * the log: the rows it replaces stay on the storage, and a checkpoint the
 * room cannot read is ignored.
 */
export interface CheckpointRow {
	/** The shape of this row. A checkpoint of another shape is ignored. */
	v: 1;
	/** No wake on a message before this seq is pending. */
	floor: Seq;
	composition: CompositionRow;
	closes: CloseRow[];
	leases: LeaseSnapshot[];
	after: Seq;
	at: string;
}

/** Whether a row read off the log is a checkpoint this room can fold. */
export function isCheckpoint(row: unknown): row is CheckpointRow {
	if (typeof row !== 'object' || row === null) return false;
	const candidate = row as Partial<CheckpointRow>;
	return (
		candidate.v === 1 &&
		typeof candidate.floor === 'number' &&
		typeof candidate.composition === 'object' &&
		candidate.composition !== null &&
		Array.isArray(candidate.closes) &&
		Array.isArray(candidate.leases)
	);
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
	steer?: { seq: Seq; line: string };
}

export interface SeatPort {
	wake(wake: Wake): Promise<void>;
	/** The room ended this activation's lease: stop it, and run what queued behind it. */
	cut(activation: string): Promise<void>;
}

// -- a seat reaching its room -------------------------------------------------

/** The one hand an activation holds, beside a seat's own tools. */
export type Hand = 'say' | 'summarise' | 'seat' | 'none';

export interface ActivationView {
	activation: string;
	seat: string;
	/** The agent's `provider/model-id`, resolved on the seat side. */
	model: string;
	lastSeq: Seq;
	systemPrompt: string;
	context: string;
	hand: Hand;
	/** The exchange this activation closes, when its hand is `summarise`. */
	closing?: { person: string; from: Seq; through: Seq };
	/** The exchange this activation composes the room for, when its hand is `seat`. */
	composing?: { person: string; from: Seq; limit: number };
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

export interface Commit {
	activation: string;
	key: string;
	readThrough?: Seq;
	intent: Intent;
}

export type CommitResponse =
	{ committed: Message } | { missed: Message[] } | { refused: string } | Stale;

export interface Lease {
	activation: string;
	phase: 'running' | 'ended';
	reason?: EndReason;
}

export type LeaseResponse = { ok: { expiry: number; lastSeq: Seq } } | Stale;

export interface SeatRoom {
	view(activation: string): Promise<ViewResponse>;
	commit(commit: Commit): Promise<CommitResponse>;
	lease(lease: Lease): Promise<LeaseResponse>;
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
