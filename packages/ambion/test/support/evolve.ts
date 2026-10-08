/**
 * One committed entry applied to a folded state. The oracle's event rules
 * run on a copy of the state's facts, so a test can step a room one entry
 * at a time and compare each step with `foldRoom`. Production advances a
 * projection with `advance`, and `projection-equivalence.test.ts` holds
 * that path equal to the oracle.
 */
import type { RoomEntry } from '../../src/journal/journal.ts';
import {
	applyEntry,
	type BaseFacts,
	type FoldOptions,
	type RoomState,
} from '../../src/room/fold.ts';
import { copyMessage } from '../../src/types.ts';
import { project } from './fold.ts';

/** The facts of a state, copied so the fold writes none of the state's own collections. */
const baseOf = (state: RoomState): BaseFacts => ({
	messages: state.messages.map(copyMessage),
	closes: [...state.closes],
	cancelledAt: state.cancelledAt,
	leases: new Map(state.leases),
	composition:
		state.composition === undefined
			? undefined
			: {
					...state.composition,
					seated: [...state.composition.seated],
					reserve: [...state.composition.reserve],
				},
	deliveries: new Map(state.deliveries),
});

/** The state after one more entry, by the rules that fold a whole journal. */
export function evolve(state: RoomState, entry: RoomEntry, options: FoldOptions): RoomState {
	const base = baseOf(state);
	applyEntry(base, entry, state.exchange, state.roster);
	return project(base, options);
}
