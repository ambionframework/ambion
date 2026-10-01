/** The room journal event vocabulary. */

import type { Static } from 'typebox';
import type {
	cancelSchema,
	closeSchema,
	compositionSchema,
	leaseSchema,
	runSchema,
	seatingSchema,
} from '../bodies.ts';
import type { Seq } from '../types.ts';

/**
 * One entry about an activation: it holds a lease, or its lease ended. A
 * failed or abandoned end carries `cause`, so a resumed room reads why the
 * activation failed and whether to try it again.
 */
export type LeaseChange = Static<typeof leaseSchema>;

/** A run took the name and fenced earlier runs. */
export interface Fence extends Static<typeof runSchema> {}

/** The room went quiet with an exchange open, and closed it. */
export type Close = Static<typeof closeSchema> & Cancelled & (OwedSummary | NoSummary);

/** What the fold adds to a close. */
interface Cancelled {
	/**
	 * A cancellation closed the exchange. A close entry never carries it: the
	 * room derives this close from the `cancel` entry. See `room/fold.ts`.
	 */
	cancelled?: true;
}

/** A close that owes a summary names its writer and the person it goes to. */
interface OwedSummary {
	summary: string;
	person: string;
}

/** A close that owes no summary. It names a person when one spoke in the range. */
interface NoSummary {
	summary?: undefined;
}

/** A room-wide cancellation marker. It closes the open exchange, when there is one. */
export interface Cancellation extends Static<typeof cancelSchema> {}

/** One seat in a composition: its name, how the room knows it, and what wakes it. */
export interface Seating extends Static<typeof seatingSchema> {}

/** What a run started with. The roster folds from the latest one. */
export interface Composition extends Static<typeof compositionSchema> {
	agents: Seating[];
	available: Seating[];
	/** Where the composition sits on the record. */
	seq: Seq;
}
