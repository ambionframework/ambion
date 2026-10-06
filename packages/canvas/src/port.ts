/** What the widget port and the breakout port share: the base port, the name limit, and the reminder tail. */
import type { ToolResult } from '@ambionframework/ambion';
import { refuse } from './cast.ts';
import type { CanvasRoom, CanvasWidget } from './store.ts';

/** The most characters of a room name or a widget name. */
export const NAME_LIMIT = 48;

/** The most lines that one reminder lists. */
const REMINDER_LINES = 10;

/** What every port of the canvas reads: the readiness, the queue of one name, and the rows. */
export interface BasePort {
	/** Refuses before `resume` and after `close`. */
	assertReady(): void;
	/** Runs the operation after the calls in flight on that name. */
	serial<T>(name: string, operation: () => Promise<T>): Promise<T>;
	row(name: string): CanvasRoom | undefined;
}

/** A base port that also reads the current revision of each widget. */
export interface CurrentPort extends BasePort {
	/** The current revision of a widget, hidden ones included. */
	current(room: string, name: string): CanvasWidget | undefined;
}

/** The items of a reminder as at most ten lines. `line` writes one line, and `and N more` ends a longer list. */
export async function reminderLines<T>(
	items: readonly T[],
	line: (item: T) => string | Promise<string>,
): Promise<string[]> {
	const shown = await Promise.all(items.slice(0, REMINDER_LINES).map(line));
	const more = items.length - shown.length;
	return more > 0 ? [...shown, `and ${more} more`] : shown;
}

/** A tool result with one line of text for the seat and the details for the host. */
export const text = <T>(summary: string, details: T): ToolResult<T> => ({
	content: [{ type: 'text', text: summary }],
	details,
});

/** A text of one line: no line terminator and no control character. */
export const oneLine = (text: string): boolean => !/[\p{Cc}\u2028\u2029]/u.test(text);

/** Refuses an empty text, a text of more than one line, and a text over the limit. */
export function assertLine(label: string, text: string, limit: number): void {
	if (text === '' || !oneLine(text)) throw refuse(`${label} is one line of text.`);
	if (text.length > limit)
		throw refuse(`${label} has ${text.length} characters. The most is ${limit}.`);
}
