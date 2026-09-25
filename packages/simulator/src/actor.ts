/**
 * The actor that plays a fixed list of moves.
 */
import type { Actor, Move } from './types.ts';

/** The reason of the `stop` that a list gives when it ends. */
export const LIST_ENDED = 'The list of moves ended.';

/**
 * An actor that plays `moves` in order. A string is a message to the room,
 * and a `Move` is sent as it is. The actor stops when the list ends. Each
 * move reads the number of exchanges the person has seen, so the list stays
 * in step with the loop.
 */
export function scriptedActor(moves: readonly (string | Move)[]): Actor {
	const list = moves.map((move): Move => (typeof move === 'string' ? { text: move } : move));
	return (seen) => list[seen.exchanges.length] ?? { stop: LIST_ENDED };
}
