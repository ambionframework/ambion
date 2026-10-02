/**
 * The ranges of the record in the session.
 *
 * The executor writes each range of the record into the session as an entry
 * of kind `ambion.record`. The entry carries `{ after, through, steer? }` as
 * data, and the text of the range reaches the model in the user input of the
 * pass. A line steered into a live pass carries its own text as the model
 * message of its entry. A session that a later activation reopens tells it
 * where the earlier one stopped reading: the largest `through` of the range
 * entries that stay in the context. An `ambion.omit` entry removes the
 * entries of a pass that did not answer.
 */
import type { ReadRange, Seq } from '@ambionframework/ambion/hosting';
import type { EntryDraft, EntryId, EntryRecord } from '@earendil-works/pi-durable';

/** The kind of an entry that marks a range of the record in the session. */
export const RECORD = 'ambion.record';

/** The kind of an entry that removes entries from the model context. */
export const OMIT = 'ambion.omit';

/** One range of the record in the session. */
export interface Range extends ReadRange {
	/** Set on a line steered into a live pass. */
	readonly steer?: true;
}

/** The data of a range entry. */
const dataOf = (range: Range) => ({
	after: range.after,
	through: range.through,
	...(range.steer === true ? { steer: true } : {}),
});

/** A marker for a range of the record. The text of the range travels in the user input. */
export function recordDraft(range: Range): EntryDraft {
	return { kind: RECORD, data: dataOf(range) };
}

/** A range of the record that carries its own text, as a user message. */
export function steerDraft(range: Range, text: string, timestamp: number): EntryDraft {
	return { kind: RECORD, data: dataOf(range), model: [{ role: 'user', content: text, timestamp }] };
}

/** An entry that removes the `targets` from the model context. */
export function omitDraft(targets: readonly EntryId[]): EntryDraft {
	return {
		kind: OMIT,
		data: { targets: [...targets] },
		edits: targets.map((target) => ({ target, action: 'omit' as const })),
	};
}

const isPosition = (value: unknown): value is Seq =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** The range an entry carries, when it is a range of the record. */
export function rangeOf(entry: EntryRecord): Range | undefined {
	if (entry.kind !== RECORD) return undefined;
	const data = entry.data;
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
	if (!isPosition(data.after) || !isPosition(data.through)) return undefined;
	return {
		after: data.after,
		through: data.through,
		...(data.steer === true ? { steer: true } : {}),
	};
}

/** The entries that an omit edit removed from the context. */
export function omittedIn(entries: readonly EntryRecord[]): ReadonlySet<EntryId> {
	const omitted = new Set<EntryId>();
	for (const entry of entries) {
		for (const edit of entry.edits ?? []) if (edit.action === 'omit') omitted.add(edit.target);
	}
	return omitted;
}
