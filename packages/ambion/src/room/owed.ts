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
import { summaryCompletion } from './exchange.ts';
import { type Owed, withAttempts } from './fold.ts';
import type { LeaseHold, PendingActivationOptions } from './lease.ts';

/** One close that owes a summary, with the draft the room owes for it. */
export interface OwedEntry {
	close: Close;
	owed: Owed;
}

/** What `judgeOwed` reads: the summary and removal messages, the closing leases, the marker. */
export interface OwedFacts {
	/** The summary and unseated messages. `summaryCompletion` reads no other kind. */
	record: readonly Message[];
	/** The leases of closing activations, by the position they name. */
	closedLeases: ReadonlyMap<Seq, ReadonlyMap<string, LeaseHold>>;
	cancelledAt: Seq | undefined;
}

/** The entry for a close, or nothing when the close owes no draft for good. */
export function judgeOwed(
	close: Close,
	facts: OwedFacts,
	options: PendingActivationOptions,
): OwedEntry | undefined {
	const leases = facts.closedLeases.get(close.through) ?? new Map<string, LeaseHold>();
	const completion = summaryCompletion(close, facts.record, leases, facts.cancelledAt);
	if (completion.status !== 'pending' || completion.writer === undefined) return undefined;
	const owed = withAttempts(
		{ person: close.owner, writer: completion.writer, from: close.from, through: close.through },
		leases,
		options,
	);
	return { close, owed };
}

/** Read again every entry the test names. The others stay as they are. */
export function rejudgeOwed(
	entries: readonly OwedEntry[],
	affected: (close: Close) => boolean,
	facts: OwedFacts,
	options: PendingActivationOptions,
): OwedEntry[] {
	return entries.flatMap((entry) => {
		if (!affected(entry.close)) return [entry];
		const next = judgeOwed(entry.close, facts, options);
		return next === undefined ? [] : [next];
	});
}
