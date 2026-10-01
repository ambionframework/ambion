/**
 * The vocabulary of a scheduled say: the bounds a runtime sets, and the one
 * shape of a say that waits. The fold, a view, and a read hold the same shape.
 */
import type { Seq } from './types.ts';

/**
 * The bounds on a scheduled say: `delaySeconds` in whole seconds from
 * `minDelaySeconds` to `maxDelaySeconds`, and at most `pending` says of one seat
 * that wait to return.
 */
export interface ScheduleLimits {
	readonly minDelaySeconds: number;
	readonly maxDelaySeconds: number;
	readonly pending: number;
}

/**
 * A say that waits to return to its seat. `seq` names it, as the record
 * shows it, and `due` is ISO.
 */
export interface ScheduledSay {
	readonly seq: Seq;
	readonly seat: string;
	readonly due: string;
	readonly text: string;
	readonly refs?: readonly string[];
}
