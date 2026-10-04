/** Pure choice of the summary writer from the recorded composition and roster. */

import type { Seating } from '../journal/entries.ts';
import type { RoomComposition } from './fold.ts';

/** Return the configured summary writer when that agent is seated. */
export function summaryWriter(
	composition: RoomComposition | undefined,
	roster: readonly Seating[],
): string | undefined {
	const writer = composition?.summaryWriter;
	return writer !== undefined && roster.some((seat) => seat.name === writer) ? writer : undefined;
}
