/**
 * A handover under load: the host that runs the room dies and another
 * resumes the name over one journal, while a seat's model fails and is
 * woken again, a seat's say wakes a peer, and people keep asking.
 *
 * `AMBION_CHAOS=all` widens the handover to a crash at every write.
 */
import { describe, it } from 'vitest';
import { troubled } from './support/cast.ts';
import { countWrites, crashOnce } from './support/core-failure.ts';
import { memory } from './support/storage.ts';

const full = process.env.AMBION_CHAOS === 'all';
const writes = await countWrites(memory, troubled());
const every = Array.from({ length: writes }, (_, i) => i + 1);
const points = full ? every : every.filter((at) => at % 3 === 0);

describe('a handover under load', () => {
	describe.each(['before', 'after'] as const)('crashed %s the entry lands', (mode) => {
		it.each(points)(
			`at write %i of ${writes}, the second host wakes the failed seat again and the record ends whole`,
			(at) => crashOnce(memory, 'hosts', { at, mode }, troubled()),
			30_000,
		);
	});
});
