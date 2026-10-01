/**
 * The contract between the core and the executor of one activation.
 *
 * The core owns what it causes or observes: the lease, its renewal, the cut,
 * the wake queue, the decision to run another pass, the read position, the
 * room tools and their binding, the prompt, the tool events, and the error
 * event. An executor owns one harness: the mapping of its events to steps,
 * the resume of a harness session, the place where it hosts the tools, and
 * the signal that the model consumed input. A session's `steer` is optional
 * because an executor family may only take context between passes.
 */
import type { ActivationView } from '../protocol.ts';
import type { FailureCause, Seq } from '../types.ts';
import type { RoomTool, RoomToolOptions } from './room-tools.ts';
import type { StepSink } from './trace.ts';

/** A range of the record: the messages after `after`, through `through`. */
export interface ReadRange {
	readonly after: Seq;
	readonly through: Seq;
}

/**
 * What the core gives an executor to open the session of one activation.
 * Every member serves the whole activation, so a session keeps it across
 * its passes.
 */
export interface ExecutorActivation {
	readonly id: string;
	/**
	 * Where the executor records the steps it owns. The core reads the
	 * `tool_call` and `tool_result` steps for the tool events. The driver owns
	 * the sink: it opens each pass, sums the usage, and closes the sink.
	 */
	readonly trace: StepSink;
	/** Aborts when the activation is cut: by the room, by the driver, or by a room tool. */
	readonly signal: AbortSignal;
	/** The highest position of the record that the model consumed: the freshness boundary. */
	readonly readThrough: Seq;
	/**
	 * The model consumed `range`: a prompt, a delta, or a steered line. A
	 * range counts once it joins the position already read, so a line that
	 * lands out of order waits until the gap closes.
	 */
	read(range: ReadRange): void;
	/** The result of the tool call `call` reached the model. */
	delivered(call: string): void;
	/**
	 * The id of the next call of `tool`, for a harness that hosts a tool where
	 * it cannot see the id: the oldest `tool_call` step of that tool that no
	 * call took yet, or a fresh id when none waits.
	 */
	callId(tool: string): string;
}

/**
 * Which record one pass reads. The first pass of an activation gets the
 * `view`: the record it reads whole. Every later pass gets a `delta`: the
 * record as it stands now, and `since`, the position the activation had read
 * through before the driver asked again.
 */
export type PassInput =
	| { readonly kind: 'view'; readonly view: ActivationView }
	| { readonly kind: 'delta'; readonly since: Seq; readonly view: ActivationView };

/** The record one pass reads, rendered, and the range of the record it holds. */
export interface PassRecord {
	readonly text: string;
	readonly range: ReadRange;
}

/** What the core hands one pass: the prompt it rendered, the tools it bound, and the session to resume. */
export type Pass = PassInput & {
	/** How a room works. It depends on the kernel version alone. */
	readonly mechanism: string;
	/** The seat's part: the name, the speaking policy, the identity, and the instructions. */
	readonly agent: string;
	/**
	 * The record this pass reads. The first pass reads the whole view, with
	 * the reminders of the tool bundles. A later pass reads the delta after
	 * `since`. `after` names the position that a resumed harness session read
	 * through: the first pass of a respond activation then reads the
	 * reminders, the pending says, and the delta after it. It gives nothing
	 * when no message is new, and the core then counts the view read.
	 */
	record(after?: Seq): Promise<PassRecord | undefined>;
	/** The id of the harness session to resume: `spec.resume`, when it names the harness of the executor. */
	readonly resume?: string;
	/** The room tools that the purpose grants, bound to the activation. Every pass holds the same values. */
	readonly tools: readonly RoomTool[];
	/** The tools of the definition in the same form. A closing activation gets none. */
	readonly agentTools: readonly RoomTool[];
};

/** What one pass reports back to the driver. */
export interface PassResult {
	readonly failed: boolean;
	/** Set only when `failed`: whether a retry can pass. */
	readonly cause?: FailureCause;
	/** Set only when `failed`: what went wrong, for the `error` event and the `end` step. */
	readonly message?: string;
	/** Set only when `failed`: the error the `error` event carries. Absent, the core builds one from `message`. */
	readonly error?: Error;
	/** Set when the model stopped because it reached a length limit. */
	readonly stop?: 'length';
}

/**
 * One activation's session with its executor: opened once, passed over as
 * the record moves, then closed. The core cuts it through the signal of the
 * activation.
 */
export interface ExecutorSession {
	/**
	 * The id of the harness session to record with the release, read after
	 * the last pass. The room hands it to the seat's next activation in the
	 * same exchange as `spec.resume`. It never reads the id.
	 */
	readonly session?: string;
	/** What the executor adds to a say and a schedule. The core reads it once, on the first pass. */
	readonly roomTools?: RoomToolOptions;
	/**
	 * Run one pass. A pass that throws is a failed pass: a `PermanentError`
	 * is permanent, and every other error is transient. A pass that the cut
	 * ends reports no failure.
	 */
	pass(pass: Pass): Promise<PassResult>;
	/**
	 * Steer a line into a live pass. Absent when the executor family cannot
	 * steer mid-run; a dropped steer is not lost, because the record already
	 * holds it, and the next pass reads it.
	 */
	steer?(after: Seq, seq: Seq, line: string): void;
	/**
	 * Release what the session holds, such as a process. The driver calls it
	 * once, after the release of the activation. A session that holds nothing
	 * leaves it out.
	 */
	close?(): void;
}

/** Builds sessions for one seat's activations. One executor per seat, for its whole lifetime. */
export interface Executor {
	/**
	 * The harness whose sessions the executor records and resumes, such as
	 * `pi`. The release records `{ harness, id }`. Absent when it keeps none.
	 */
	readonly harness?: string;
	open(activation: ExecutorActivation): ExecutorSession;
}
