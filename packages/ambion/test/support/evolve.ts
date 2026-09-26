/**
 * One committed entry applied to a folded state. The oracle's event rules
 * run on a copy of the state's facts, so a test can step a room one entry
 * at a time and compare each step with `foldRoom`. Production advances a
 * projection with `advance`, and `projection-equivalence.test.ts` holds
 * that path equal to the oracle.
 */
import type { Entry } from '../../src/journal/journal.ts';
import {
	applyEvent,
	type BaseFacts,
	type FoldOptions,
	type RoomState,
} from '../../src/room/fold.ts';
import { project } from './fold.ts';

/** The facts of a state, copied so the fold writes none of the state's own collections. */
const baseOf = (state: RoomState): BaseFacts => ({
	messages: [...state.messages],
	closes: [...state.closes],
	cancelledAt: state.cancelledAt,
	cancelClosed: [...state.cancelClosed],
	leases: new Map(state.leases),
	composition: state.composition,
	deliveries: new Map(state.deliveries),
});

/** The state after one more entry, by the rules that fold a whole journal. */
export function evolve(state: RoomState, entry: Entry, options: FoldOptions): RoomState {
	const base = baseOf(state);
	applyEvent(base, entry);
	return project(base, options);
}
