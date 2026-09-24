/**
 * The contract between the driver and one activation's executor.
 *
 * The driver owns the lease, its renewal, the cut, the wake queue, and the
 * decision to run another pass. An executor owns one pass over the record
 * it is handed: it renders a prompt, runs its model loop once, and reports
 * where it left off. A session's `steer` is
 * optional because a later executor family may only take context between
 * passes, never during one.
 */
import type { ActivationView, RoomProtocol } from '../protocol.ts';
import type { ExecutionEvent, FailureCause, HarnessSession, Seq } from '../types.ts';
import type { TraceSink } from './trace.ts';

/** What one activation gives its executor to open a session. */
export interface ExecutorActivation {
	readonly id: string;
	/** The bounded room facade: the driver's own retries and cancellation. */
	readonly room: RoomProtocol;
	readonly emit: (event: ExecutionEvent) => void;
	/** Where the executor records the steps it owns. The driver owns the sink and closes it. */
	readonly trace: TraceSink;
}

/**
 * What the driver hands one pass. The first pass of an activation gets the
 * `view`: the record it reads whole. Every later pass gets a `delta`: the
 * record as it stands now, and `since`, the position the session had read
 * through before the driver asked again. A session that keeps its model
 * loop across passes prompts with what came after `since`; a session that
 * does not reads the view whole.
 */
export type PassInput =
	| { readonly kind: 'view'; readonly view: ActivationView }
	| { readonly kind: 'delta'; readonly since: Seq; readonly view: ActivationView };

/** What one pass reports back to the driver. */
export interface PassResult {
	readonly failed: boolean;
	/** Set only when `failed`: whether a retry can pass. */
	readonly cause?: FailureCause;
	/** Set only when `failed`: what went wrong, for the `end` step. */
	readonly message?: string;
	/** Set when the model stopped because it reached a length limit. */
	readonly stop?: 'length';
}

/**
 * One activation's session with its executor: opened once, passed over as
 * the record moves, then discarded. `readThrough` is the freshness boundary — the
 * highest position the session has consumed — and the driver reads it both
 * mid-pass, to renew the lease, and after, to release it.
 */
export interface ExecutorSession {
	readonly readThrough: Seq;
	/**
	 * The harness session to record with the release, read after the last
	 * pass beside `readThrough`. A harness with no session leaves it out. The
	 * room records the id and hands it to the seat's next activation in the
	 * same exchange as `spec.resume`; it never reads the id.
	 */
	readonly session?: HarnessSession;
	/**
	 * Whether `abort` was called. The driver checks this before it asks the
	 * room for anything else on this session's behalf: a cancelled session
	 * never earns another round trip, whatever `shouldRefresh` would say.
	 */
	readonly cancelled: boolean;
	pass(input: PassInput): Promise<PassResult>;
	/**
	 * Steer context into a live pass. Absent when the executor family cannot
	 * steer mid-run; a dropped steer is not lost, because the record already
	 * holds it, and the next pass the driver runs rereads the record whole.
	 */
	steer?(after: Seq, seq: Seq, line: string): void;
	/**
	 * Whether the session has work queued for another pass without new room
	 * content, given the room's current last position. A cancelled session
	 * always answers no.
	 */
	shouldRefresh(lastSeq: Seq): boolean;
	/**
	 * Cut a pass in flight. This is not itself a provider failure, so the
	 * pass in progress still reports whatever it was already going to
	 * report; `cancelled` is what stops the driver from running another.
	 */
	abort(): void;
	/**
	 * Release what the session holds, such as a process. The driver calls it
	 * once, after the release of the activation and after `abort`. A session
	 * that holds nothing leaves it out.
	 */
	close?(): void;
}

/** Builds sessions for one seat's activations. One executor per seat, for its whole lifetime. */
export interface Executor {
	open(activation: ExecutorActivation): ExecutorSession;
}
