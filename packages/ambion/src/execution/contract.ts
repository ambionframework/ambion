import type { AmbionTool, ToolContent } from '../bundle.ts';
import type { ActivationView } from '../protocol.ts';
import type { FailureCause, Seq, Step, Usage } from '../types.ts';

// -- the executor contract ----------------------------------------------------

// The contract between the driver and the running activation of an executor.
//
// The driver owns what it causes or observes: the lease, its renewal, the cut,
// the wake queue, the decision to run another pass, the read position, the
// room tools and their binding, the prompt, the tool events, and the error
// event. A running activation owns one harness: the mapping of its events to
// steps, the resume of a vendor session, the place where it hosts the
// tools, and the signal that the model consumed input. Its `steer` is
// optional because an executor kind may only take context between passes.
// The driver records the `steer` step of every steered line.

/** What a room tool or an agent tool hands back to the model. */
export interface BoundToolResult {
	readonly content: readonly ToolContent[];
	/** The model reads the content as an error. */
	readonly isError?: true;
	/**
	 * The content carries lines of the record that the model has not read. A
	 * `compose` call that ran the tool then shows the content in its own result.
	 */
	readonly carriesRecord?: true;
	/** The activation has nothing more to do: the executor may end its model loop. */
	readonly terminate?: true;
}

/** One tool as a harness lists it, and what runs when the model calls it. */
export interface BoundTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: AmbionTool['parameters'];
	/** Run one call. `call` is the id the harness gave it, and the idempotency key of a commit. */
	run(args: unknown, call: string): Promise<BoundToolResult>;
}

/** What the driver and the executor write to. One sink serves one activation. */
export interface TraceSink {
	/** Open a pass. The sink stamps this pass on every step until the next one. */
	startPass(input: 'view' | 'delta', through: Seq): void;
	/**
	 * Record one raw step. The sink joins consecutive `thinking` and `text`
	 * deltas into one block. A block ends at a `final` step or at a step of
	 * another type.
	 */
	record(step: Step): void;
	/**
	 * The sum of every `usage` step recorded so far, or nothing when none came.
	 * The sum counts steps the pass cap dropped, and steps with no logger.
	 */
	usage(): Usage | undefined;
	/** Give the block in progress to the logger. */
	close(): Promise<void>;
}

/** The part of a sink an executor writes to: it records the steps it owns. */
export type StepSink = Pick<TraceSink, 'record'>;

/** Opens the sink of one activation. */
export interface TraceOpener {
	open(activation: string): TraceSink;
}

/** A range of the record: the messages after `after`, through `through`. */
export interface ReadRange {
	readonly after: Seq;
	readonly through: Seq;
}

/**
 * What the driver gives an `ActivationOpener` to open one activation. Every
 * member serves the whole activation, so a running activation keeps it
 * across its passes.
 */
export interface ExecutorActivation {
	readonly id: string;
	/**
	 * Where the executor records the steps it owns. The driver reads the
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
	 * range that `steer` received. The driver then records the consumed `steer`
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
 * record as it stands now, and `after`, the position the activation had read
 * through before the driver asked again.
 */
export type PassInput =
	| { readonly kind: 'view'; readonly view: ActivationView }
	| { readonly kind: 'delta'; readonly after: Seq; readonly view: ActivationView };

/** The record one pass reads, rendered, and the range of the record it holds. */
export interface PassRecord {
	readonly text: string;
	readonly range: ReadRange;
}

/** What the driver hands one pass: the prompt it rendered, the tools it bound, and the session to resume. */
export type Pass = PassInput & {
	/** How a room works. It depends on the kernel version alone. */
	readonly mechanism: string;
	/** The seat's part: the name, the speaking policy, the identity, and the instructions. */
	readonly agent: string;
	/**
	 * The record this pass reads. The first pass reads the whole view, with
	 * the reminders of the tool bundles. A later pass reads the delta after
	 * the `after` of its input. The argument `after` names the position that
	 * a resumed vendor session read through: the first pass of a respond
	 * activation then reads the reminders, the scheduled says, and the delta
	 * after it. It gives nothing when no message is new, and the driver then
	 * counts the view read.
	 */
	record(after?: Seq): Promise<PassRecord | undefined>;
	/** The id of the vendor session to resume: `spec.resume`, when its kind is the kind of the executor. */
	readonly resumeId?: string;
	/**
	 * The room tools that the purpose grants, then the tools of the
	 * definition, bound to the activation. A summary activation gets the room
	 * tools alone. Every pass holds the same values.
	 */
	readonly tools: readonly BoundTool[];
};

/** What one pass reports back to the driver. */
export interface PassResult {
	readonly failed: boolean;
	/** Set only when `failed`: whether a retry can pass. */
	readonly cause?: FailureCause;
	/** Set only when `failed`: what went wrong, for the `error` event and the `end` step. */
	readonly message?: string;
	/** Set only when `failed`: the error the `error` event carries. Absent, the driver builds one from `message`. */
	readonly error?: Error;
	/** Set when the model stopped because it reached a length limit. */
	readonly stop?: 'length';
}

/**
 * One activation of a seat, as its executor runs it: opened once, passed over
 * as the record moves, then closed. The driver cuts it through the signal of
 * the activation.
 */
export interface RunningActivation {
	/**
	 * The id of the vendor session to record with the release, read after
	 * the last pass. The driver records it under the executor kind. The room
	 * hands it to the seat's next activation in the same exchange as
	 * `spec.resume`. It never reads the id.
	 */
	readonly session?: string;
	/**
	 * Run one pass. A pass that throws is a failed pass: a `PermanentError`
	 * is permanent, and every other error is transient. A pass that the cut
	 * ends reports no failure.
	 */
	pass(pass: Pass): Promise<PassResult>;
	/**
	 * Deliver a line to the pass in flight, when the harness can take it. The
	 * driver calls `steer` at any moment after it calls `pass` and before that
	 * pass settles, also before the body of `pass` reaches its first `await`.
	 * Hold a line that the harness cannot take yet, deliver it when the harness
	 * can, and drop what you hold when `pass` settles. The driver records the
	 * `steer` step, and the executor records none. The executor reads
	 * `{ after, through: seq }` when the model consumes the line. A line that
	 * the pass does not read waits for the next delta, and the step says so. A
	 * `steer` that throws counts as a line the pass does not read. An executor
	 * kind that cannot steer mid-run leaves `steer` out. The record already holds
	 * the line, and the next pass reads it.
	 */
	steer?(after: Seq, seq: Seq, line: string): void;
	/**
	 * Release what the running activation holds, such as a process. The driver
	 * calls it once, after the release of the activation. A running activation
	 * that holds nothing leaves it out.
	 */
	close?(): void;
}

/**
 * Opens one activation of one seat. One opener per seat, for its whole
 * lifetime. The driver records and resumes vendor sessions under the seat's
 * executor kind, `definition.executor.kind`.
 */
export type ActivationOpener = (activation: ExecutorActivation) => RunningActivation;
