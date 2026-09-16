/** The room journal event vocabulary. */

import type { Attention, EndReason, Seq } from '../types.ts';

/** One entry about an activation: it holds a lease, or its lease ended. */
export type LeaseChange =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: Seq }
	| { id: string; phase: 'ended'; reason: EndReason; at: string; readThrough: Seq };

/** A run took the name and fenced earlier runs. */
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
