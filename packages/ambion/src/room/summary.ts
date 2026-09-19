/** Pure summary assignment from the recorded composition and roster. */

import type { Composition, Seating } from '../journal/events.ts';
import { namesWriter } from './rules.verified.ts';

/** Return the configured summary writer when that agent is seated. */
export function summaryWriter(
	composition: Composition | undefined,
	roster: readonly Seating[],
): string | undefined {
	const writer = composition?.summary;
	const seated = writer !== undefined && roster.some((seat) => seat.name === writer);
	// The rule decides; the second check only narrows the type.
	return namesWriter(writer !== undefined, seated) && writer !== undefined ? writer : undefined;
}
