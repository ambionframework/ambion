import type { Context } from '@earendil-works/pi-ai';
import {
	contextText,
	quiet,
	type Script,
	speak,
	toolResultTexts,
} from '../../../pi/src/testing.ts';

export {
	byAgent,
	callTool,
	contextText,
	isClosing,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
	toolNames,
	toolResultTexts,
} from '../../../pi/src/testing.ts';

// Closing publications use the same model tool as ordinary speech.
export const summarise = (text: string) => speak(text);

/**
 * A seat that answers the last question a person asked, once. A question
 * directed at a colleague is the colleague's to answer. A refused say is
 * said again; a delivered one ends the pass; a record that already holds
 * the answer stays quiet.
 */
export const answersLastQuestion =
	(people: string[]): Script =>
	(context, name) => {
		const text = contextText(context);
		const asked = new RegExp(
			`^\\[(?:${people.join('|')})(?: → ([a-z0-9-]+))?\\] (.+?)(?: {2}\\(.*\\))?$`,
			'gm',
		);
		const last = [...text.matchAll(asked)].at(-1);
		const question = last?.[2];
		if (question === undefined || (last?.[1] !== undefined && last[1] !== name)) return quiet();
		const answer = `${name} on ${question}`;
		if (text.includes(`[${name}] ${answer}`) || toolResultTexts(context).includes('delivered')) {
			return quiet();
		}
		return speak(answer);
	};

/**
 * The questions the seat has not answered, oldest first: every line one of
 * `people` said, less the ones directed at another seat, the ones the
 * record already holds an answer to, and the ones this activation
 * delivered an answer to.
 */
export function unanswered(context: Context, name: string, people: string[]): string[] {
	const text = contextText(context);
	const asked = new RegExp(
		`^\\[(?:${people.join('|')})(?: → ([a-z0-9-]+))?\\] (.+?)(?: {2}\\(.*\\))?$`,
		'gm',
	);
	const open = [...text.matchAll(asked)]
		.filter((line) => line[1] === undefined || line[1] === name)
		.map((line) => line[2] ?? '')
		.filter((question) => !text.includes(`[${name}] ${name} on ${question}`));
	const delivered = toolResultTexts(context).filter((result) => result === 'delivered').length;
	return open.slice(delivered);
}

/**
 * A seat that answers every question it was asked, one say per model call,
 * oldest first. A refused say is said again, and a record that holds every
 * answer stays quiet.
 */
export const answersEveryQuestion =
	(people: string[]): Script =>
	(context, name) => {
		const next = unanswered(context, name, people)[0];
		return next === undefined ? quiet() : speak(`${name} on ${next}`);
	};

/**
 * A seat that says one thing and means it: a refused say is said again, and
 * a delivered one ends the pass. What lands beside it never changes its mind.
 */
export const insists = (text: string, to?: string): Script => says([text], to);

/**
 * A seat that says these things, in this order, once each, however the room
 * moves under it: a refused say is said again, a delivered one moves on, and
 * a say the record already holds is not said twice.
 */
export const says =
	(texts: string[], to?: string): Script =>
	(context, name) => {
		const record = contextText(context);
		const pending = texts.filter(
			(text) => !record.includes(`[${name}${to ? ` → ${to}` : ''}] ${text}`),
		);
		const delivered = toolResultTexts(context).filter((text) => text === 'delivered').length;
		const next = pending[delivered];
		return next === undefined ? quiet() : speak(next, to);
	};
