import { ellipsize } from './text.ts';

/** The cells between the left text and the right text of one row. */
export const GAP = 2;

export interface HeaderFitInput {
	/** The cells one row has, inside the border and the padding. */
	width: number;
	name: string;
	goal: string;
	identity: string;
	/** The cells the participants take on their row. */
	people: number;
	pattern: string;
}

export interface HeaderFit {
	goal: string;
	pattern: string;
}

/**
 * Decide what the rows of the header show at one width. The goal takes the cells
 * that the room name and the identity leave, and it ends with an ellipsis when it
 * is longer. The pattern shows only when it fits on the row of the participants.
 */
export function fitHeader(input: HeaderFitInput): HeaderFit {
	const { width, name, identity } = input;
	const taken = name.length + GAP + (identity ? identity.length + GAP : 0);
	const goal = ellipsize(input.goal, width - taken);
	const fits = input.people + GAP + input.pattern.length <= width;
	return { goal, pattern: fits ? input.pattern : '' };
}
