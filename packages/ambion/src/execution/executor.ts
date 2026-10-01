/**
 * The contract between the core and the executor of one activation.
 *
 * The core owns what it causes or observes: the lease, its renewal, the cut,
 * the wake queue, the decision to run another pass, the read position, the
 * room tools and their binding, the prompt, the tool events, and the error
 * event. An executor owns one harness: the mapping of its events to steps,
 * the resume of a harness session, the place where it hosts the tools, and
 * the signal that the model consumed input. A session's `steer` is optional
 * because an executor kind may only take context between passes. The core
 * records the `steer` step of every steered line.
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
	 * lands out of order waits until the gap closes. A steered line is
	 * consumed when the executor reads `{ after, through: seq }` for it, the
	 * range that `steer` received. The core then records the consumed `steer`
	 * step.
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
	/** The id of the harness session to resume: `spec.resume`, when it names the kind of the executor. */
	readonly resume?: string;
	/**
	 * The room tools that the purpose grants, then the tools of the
	 * definition, bound to the activation. A closing activation gets the room
	 * tools alone. Every pass holds the same values.
	 */
	readonly tools: readonly RoomTool[];
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
	 * the last pass. The core records it under the executor kind. The room
	 * hands it to the seat's next activation in the same exchange as
	 * `spec.resume`. It never reads the id.
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
	 * Deliver a line to the pass in flight, when the harness can take it. The
	 * core calls `steer` at any moment after it calls `pass` and before that
	 * pass settles, also before the body of `pass` reaches its first `await`.
	 * Hold a line that the harness cannot take yet, deliver it when the harness
	 * can, and drop what you hold when `pass` settles. The core records the
	 * `steer` step, and the executor records none. The executor reads
	 * `{ after, through: seq }` when the model consumes the line. A line that
	 * the pass does not read waits for the next delta, and the step says so. A
	 * `steer` that throws counts as a line the pass does not read. An executor
	 * kind that cannot steer mid-run leaves `steer` out. The record already holds
	 * the line, and the next pass reads it.
	 */
	steer?(after: Seq, seq: Seq, line: string): void;
	/**
	 * Release what the session holds, such as a process. The driver calls it
	 * once, after the release of the activation. A session that holds nothing
	 * leaves it out.
	 */
	close?(): void;
}

/**
 * Opens the session of one activation of one seat. One executor per seat,
 * for its whole lifetime. The core records and resumes harness sessions
 * under the seat's executor kind, `definition.executor.kind`.
 */
export type Executor = (activation: ExecutorActivation) => ExecutorSession;
