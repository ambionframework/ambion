/** Pure summary assignment from the recorded composition and roster. */

import type { Composition, Seating } from '../journal/events.ts';

/** Return the configured summary writer when that agent is seated. */
export function summaryWriter(
	composition: Composition | undefined,
	roster: readonly Seating[],
): string | undefined {
	const writer = composition?.summary;
	return writer !== undefined && roster.some((seat) => seat.name === writer) ? writer : undefined;
}
