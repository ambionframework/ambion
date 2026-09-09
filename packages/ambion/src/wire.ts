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
 * seat through one: `wake` names a message the seat has to hear, and the
 * seat side decides whether that starts an activation or steers the one
 * that runs.
 */
import type { Attention, Message, Seq } from './types.ts';

// -- rows on the log beside the messages --------------------------------------

/** `Omit` over each member of a union, so a discriminated row keeps its shape. */
export type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Why a lease ended. */
export type EndReason = 'released' | 'failed' | 'refused' | 'revoked' | 'expired';

/**
 * One row about an activation: it holds a lease, or its lease ended.
 * `heard` is the seq the activation has taken: what its view held when it
 * claimed, then every message the seat side steered into it. A wake is
 * answered once a lease of the seat has heard it.
 */
export type LeaseRow =
	| { id: string; after: Seq; phase: 'running'; expiry: number; heard: Seq; at: string }
	| { id: string; after: Seq; phase: 'ended'; reason: EndReason; heard: Seq; at: string };

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
	attention: Attention;
}

/** What a run started with. The roster folds from the latest one. */
export interface CompositionRow {
	assistant: string;
	goal?: string;
	agents: SeatRow[];
	available: SeatRow[];
	after: Seq;
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
	steer?: { seq: Seq; line: string };
}

export interface SeatPort {
	wake(wake: Wake): Promise<void>;
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
	/** The seq the activation has taken. The room keeps the higher of this and what it holds. */
	heard?: Seq;
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
