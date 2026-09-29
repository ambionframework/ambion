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
			/** The harness session the activation ended with, when the harness reports one. */
			session?: HarnessSession;
	  };

/** A run took the name and fenced earlier runs. */
export interface Fence {
	at: string;
}

/** The room went quiet with an exchange open, and closed it. */
export type Close = CloseRange & (OwedSummary | NoSummary);

/** What every close holds. */
interface CloseRange {
	from: Seq;
	through: Seq;
	at: string;
	/**
	 * A cancellation closed the exchange. A close entry never carries it: the
	 * room derives this close from the `cancel` entry. See `room/fold.ts`.
	 */
	cancelled?: true;
}

/** A close that owes a summary names its writer and the person it goes to. */
interface OwedSummary {
	/** The configured seated agent that writes the summary. */
	summary: string;
	/** The first person who spoke in the range. */
	person: string;
}

/** A close that owes no summary. It names a person when one spoke in the range. */
interface NoSummary {
	summary?: undefined;
	person?: string;
}

/** A room-wide cancellation marker. It closes the open exchange, when there is one. */
export interface Cancellation {
	at: string;
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
	goal?: string;
	/** The configured agent that writes summaries for human owners. */
	summary?: string;
	agents: Seating[];
	available: Seating[];
	/** Where the composition sits on the record. */
	seq: Seq;
	at: string;
}
