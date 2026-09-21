/** The room journal event vocabulary. */

import type { Attention, EndReason, FailureCause, HarnessSession, Seq, Usage } from '../types.ts';

/**
 * One entry about an activation: it holds a lease, or its lease ended. A
 * failed or abandoned end carries `cause`, so a resumed room reads why the
 * activation failed and whether to try it again.
 */
export type LeaseChange =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: Seq }
	| {
			id: string;
			phase: 'ended';
			reason: EndReason;
			at: string;
			readThrough: Seq;
			cause?: FailureCause;
			/** What the activation spent, on an end its driver wrote. */
			usage?: Usage;
			/** The harness session the activation ended with, when the harness keeps memory. */
			session?: HarnessSession;
	  };

/**
 * The format of the journal the room writes. Every `run` entry carries it,
 * and a reader refuses a format it does not know. `docs/durability.md` §4
 * holds the compatibility promise.
 */
export const JOURNAL_FORMAT = 1;

/** A run took the name and fenced earlier runs. */
export interface Fence {
	at: string;
	/** The journal format the run writes. A journal without it is format 1. */
	format: 1;
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

/** A room-wide cancellation marker, with an optional close for open work. */
export interface Cancellation {
	at: string;
	close?: Omit<Close, 'summary'>;
}

/** One seat in a composition: its name, how the room knows it, and what wakes it. */
export interface Seating {
	name: string;
	identity: string;
	attention: Attention;
	/** An agent cannot unseat this seat, when stated. See `room/fold.ts`'s `isFixed`. */
	fixed?: boolean;
}

/** What a run started with. The roster folds from the latest one. */
export interface Composition {
	version: 2;
	goal?: string;
	/** The configured agent that writes summaries for human owners. */
	summary?: string;
	agents: Seating[];
	available: Seating[];
	/** Where the composition sits on the record. */
	seq: Seq;
	at: string;
}
