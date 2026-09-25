/**
 * The vocabulary of a scheduled say that a host and a view read: the bounds
 * a runtime sets, and a pending say as a read shows it.
 */
import type { Seq } from './types.ts';

/**
 * The bounds on a scheduled say: `after` in whole seconds from `minAfter` to
 * `maxAfter`, and at most `pending` says of one seat that wait to return.
 */
export interface ScheduleLimits {
	readonly minAfter: number;
	readonly maxAfter: number;
	readonly pending: number;
}

/**
 * A say that waits to return to its seat for its owner, as a read shows it.
 * `seq` is its handle, and `due` is ISO.
 */
export interface PendingSay {
	readonly seq: Seq;
	readonly seat: string;
	readonly owner: string;
	readonly due: string;
	readonly text: string;
	readonly refs?: readonly string[];
}
