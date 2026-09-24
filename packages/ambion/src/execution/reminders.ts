/**
 * The bundle reminders of one activation, resolved once.
 *
 * A reminder can read I/O, such as the process table of a workspace on a
 * remote server. The executor resolves the reminders once, at the start of
 * an activation, and hands the text to `renderActivation`. A second render
 * of the same activation then reads the same text, and calls no reminder.
 */

import type { Reminder, ReminderSeat } from '../bundle.ts';
import type { ActivationView } from '../protocol.ts';
import type { AgentDefinition } from '../types.ts';

/** The longest one reminder can take. A reminder past it gives no text, and the activation goes on. */
export const REMINDER_TIMEOUT_MS = 5_000;

/**
 * The text of the agent's bundle reminders for a respond activation, as
 * paragraphs, or undefined for nothing. A summarize activation has no tools
 * of the agent, so it calls none. The reminders run together.
 */
export async function resolveReminders(
	view: ActivationView,
	def: AgentDefinition,
): Promise<string | undefined> {
	const reminders = def.executor.reminders;
	if (reminders === undefined || view.spec.purpose.kind !== 'respond') return undefined;
	const seat = { agent: def.name, room: view.context.name, activation: view.spec.id };
	const texts = await Promise.all(reminders.map((remind) => bounded(remind, seat)));
	const kept = texts.filter((text): text is string => text !== undefined);
	return kept.length === 0 ? undefined : kept.join('\n\n');
}

/**
 * One reminder's text: undefined when it throws, rejects, gives blank text,
 * or passes the timeout. The timeout aborts the reminder's signal first, so
 * a late reminder can see that the executor drops its text.
 */
async function bounded(remind: Reminder, seat: ReminderSeat): Promise<string | undefined> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => {
			controller.abort(new Error('The reminder passed its timeout.'));
			resolve(undefined);
		}, REMINDER_TIMEOUT_MS);
	});
	try {
		const text = await Promise.race([
			Promise.resolve().then(() => remind(seat, controller.signal)),
			late,
		]);
		const trimmed = text?.trim();
		return trimmed === '' ? undefined : trimmed;
	} catch {
		// A reminder is a courtesy of a bundle: the activation runs without it.
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}
