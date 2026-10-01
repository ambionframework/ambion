/**
 * The one shape of a workspace capability, and the helpers that compose
 * capabilities into a bundle. `workspaceTools` in `./workspace.ts` holds the
 * order of the capabilities, and `withSkills` reuses the same helpers.
 */

import type { AmbionTool, Reminder, ReminderSeat } from '@ambionframework/ambion';

/** One capability of a workspace, as a bundle holds it: its tools, its guidance notes, and its reminder. */
export interface Capability {
	readonly tools: readonly AmbionTool[];
	/** Paragraphs of guidance, in order. `joinNotes` drops an empty or undefined note. */
	readonly notes: readonly (string | undefined)[];
	/** Text for one respond activation of one seat, or undefined for none. */
	readonly remind?: Reminder;
}

/** The notes that are set, joined as paragraphs in the order given. */
export function joinNotes(notes: readonly (string | undefined)[]): string {
	return notes.filter((note): note is string => note !== undefined && note !== '').join('\n\n');
}

/** The text of one reminder, or undefined when it rejects or gives a blank text. */
async function textOf(
	remind: Reminder,
	seat: ReminderSeat,
	signal: AbortSignal,
): Promise<string | undefined> {
	try {
		const text = await remind(seat, signal);
		return text === undefined || text.trim() === '' ? undefined : text;
	} catch {
		return undefined;
	}
}

/**
 * One reminder over `reminders`. It starts every reminder at once, in the
 * order given, and joins the texts with a blank line. A reminder that
 * rejects or gives a blank text adds nothing. It gives undefined when no
 * reminder gives text, and it is undefined when `reminders` holds none.
 */
export function mergeReminders(reminders: readonly (Reminder | undefined)[]): Reminder | undefined {
	const set = reminders.filter((remind): remind is Reminder => remind !== undefined);
	if (set.length === 0) return undefined;
	return async (seat, signal) => {
		const texts = await Promise.all(set.map((remind) => textOf(remind, seat, signal)));
		return texts.filter((text) => text !== undefined).join('\n\n') || undefined;
	};
}
