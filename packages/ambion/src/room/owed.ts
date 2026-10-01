/**
 * The summaries still owed, as an index that one entry updates.
 *
 * A close stays in the index while its summary is pending. A published
 * summary, a silent or failed verdict, a removed writer, and a cancellation
 * are final, so the index drops the close. A lease of the close's writer, a
 * summary, or a removal changes only the closes it names, and the index reads
 * those again. The rules are the ones `exchange.ts` holds.
 */

import type { Close } from '../journal/events.ts';
import type { Message, Seq } from '../types.ts';
import { draftsOf, type SummaryClose, summaryCompletion } from './exchange.ts';
import {
	type LeaseHold,
	type PendingActivation,
	type PendingActivationOptions,
	pendingActivation,
} from './lease.ts';
import { countsAgainst } from './rules.verified.ts';

/**
 * A summary one person is owed, and how the room has tried to write it. The
 * seat is the writer that the close named, and the position is the close's
 * `through`, the boundary that the summary must retain.
 */
export interface Owed extends PendingActivation {
	person: string;
	/** The opening question that identifies the closed exchange. */
	from: Seq;
}

/** What `judgeOwed` reads: the summary and removal messages, the closing leases, the marker. */
export interface OwedFacts {
	/** The summary and unseated messages. `summaryCompletion` reads no other kind. */
	summaryFacts: readonly Message[];
	/** The leases of closing activations, by the position they name. */
	closedLeases: ReadonlyMap<Seq, ReadonlyMap<string, LeaseHold>>;
	cancelledAt: Seq | undefined;
}

const closeOf = (owed: Owed): SummaryClose => ({
	person: owed.person,
	from: owed.from,
	through: owed.position,
	summary: owed.seat,
});

/** The summary a close owes, or nothing when the close owes no draft for good. */
export function judgeOwed(
	close: SummaryClose,
	facts: OwedFacts,
	options: PendingActivationOptions,
): Owed | undefined {
	// A close with no writer owes no draft. A close with one names its person.
	if (close.summary === undefined) return undefined;
	const leases = facts.closedLeases.get(close.through) ?? new Map<string, LeaseHold>();
	const completion = summaryCompletion(close, facts.summaryFacts, leases, facts.cancelledAt);
	if (completion.status !== 'pending' || completion.writer === undefined) return undefined;
	return withAttempts(close, completion.writer, leases, options);
}

/** Read again every owed summary that the test names. The others stay as they are. */
export function rejudgeOwed(
	owed: readonly Owed[],
	affected: (owed: Owed) => boolean,
	facts: OwedFacts,
	options: PendingActivationOptions,
): Owed[] {
	return owed.flatMap((entry) => {
		if (!affected(entry)) return [entry];
		const next = judgeOwed(closeOf(entry), facts, options);
		return next === undefined ? [] : [next];
	});
}

/**
 * What a person is owed, as an activation: how many drafts over the close
 * came to nothing, when the next may start, and the id it claims. The room
 * reads the attempts only while the close owes a draft. Then no draft stood
 * down, so an ended draft failed or expired.
 */
export function withAttempts(
	close: Pick<Close, 'from' | 'through'> & { readonly person: string },
	writer: string,
	leases: ReadonlyMap<string, LeaseHold>,
	options: PendingActivationOptions,
): Owed {
	const failed = draftsOf(leases, close.through, writer).filter((lease) =>
		countsAgainst(lease, close.through),
	);
	return {
		person: close.person,
		from: close.from,
		...pendingActivation('closed', close.through, writer, failed, options),
	};
}
