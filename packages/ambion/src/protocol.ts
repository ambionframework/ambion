/**
 * What crosses between a seat and its room. Every request and response is
 * plain JSON: an optional key is written only when it is present, and no
 * value is `undefined`, a `Date`, a `Map`, a `Set`, a class instance or a
 * function. A
 * request and its response survive a round trip through `JSON.stringify`
 * unchanged, which is what lets a seat and a room live in two processes.
 *
 * The seat reaches the room through three calls: `view` reads what an
 * activation is given, `commit` puts one message on the record, and
 * `lease` claims, renews or releases the activation. The room reaches a
 * seat through three calls: `wake` starts an activation, `steer` sends
 * context to one running activation, and `cut` stops an activation whose
 * lease the room ended.
 *
 * The file also holds the executor contract: the types between the driver
 * and one running activation in the same process. They hold functions, and
 * they do not cross the wire.
 */

import type { Static } from 'typebox';
import type { leaseEndedSchema } from './bodies.ts';
import type { AmbionTool, ToolContent } from './bundle.ts';
import type { ScheduledSay } from './scheduling.ts';
import type {
	AgentParticipant,
	FailureCause,
	HumanParticipant,
	Intent,
	Message,
	Seq,
	Step,
	Usage,
	VendorSession,
	Without,
} from './types.ts';

/** The work authorized by the room, with the facts that purpose requires. */
export type ActivationPurpose =
	| { readonly kind: 'respond'; readonly message: Seq }
	| {
			readonly kind: 'summarize';
			readonly exchange: Seq;
			/** The person of the exchange, whose summary completes the close. */
			readonly person: string;
			/** Every person the summary activation addresses, `person` first. */
			readonly people: readonly string[];
			readonly through: Seq;
	  };

/** The authority one recorded activation grants to its seat. */
export interface ActivationSpec {
	readonly id: string;
	readonly seat: string;
	readonly attempt: number;
	readonly purpose: ActivationPurpose;
	/**
	 * The session that the seat's latest ended activation in the same exchange
	 * recorded. The harness resumes it, and starts fresh when it is absent.
	 * The room only carries it.
	 */
	readonly resume?: VendorSession;
}

// -- the room reaching a seat -------------------------------------------------

/** A wake names an activation the seat runs. */
export interface Wake {
	room: string;
	seat: string;
	activation: string;
}

/** A message the room sends to one activation that is already running. */
export interface Steer {
	room: string;
	seat: string;
	/** The exact activation that was at work when the message landed. */
	activation: string;
	after: Seq;
	message: Message;
}

export interface AgentPort {
	wake(wake: Wake): Promise<void>;
	steer(steer: Steer): Promise<void>;
	/** The room ended this activation's lease: stop it, and run what queued behind it. */
	cut(activation: string): Promise<void>;
}

// -- the executor contract ----------------------------------------------------

// The contract between the core and the running activation of an executor.
//
// The core owns what it causes or observes: the lease, its renewal, the cut,
// the wake queue, the decision to run another pass, the read position, the
// room tools and their binding, the prompt, the tool events, and the error
// event. A running activation owns one harness: the mapping of its events to
// steps, the resume of a vendor session, the place where it hosts the
// tools, and the signal that the model consumed input. Its `steer` is
// optional because an executor kind may only take context between passes.
// The core records the `steer` step of every steered line.

/** What a room tool or an agent tool hands back to the model. */
export interface RoomToolResult {
	readonly content: readonly ToolContent[];
	/** The model reads the content as an error. */
	readonly isError?: true;
	/** The activation has nothing more to do: the executor may end its model loop. */
	readonly terminate?: true;
}

/** One tool as a harness lists it, and what runs when the model calls it. */
export interface RoomTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: AmbionTool['parameters'];
	/** Run one call. `call` is the id the harness gave it, and the idempotency key of a commit. */
	run(args: unknown, call: string): Promise<RoomToolResult>;
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
 * What the core gives an `ActivationOpener` to open one activation. Every
 * member serves the whole activation, so a running activation keeps it
 * across its passes.
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

/** What the core hands one pass: the prompt it rendered, the tools it bound, and the session to resume. */
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
	 * after it. It gives nothing when no message is new, and the core then
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
 * One activation of a seat, as its executor runs it: opened once, passed over
 * as the record moves, then closed. The core cuts it through the signal of
 * the activation.
 */
export interface RunningActivation {
	/**
	 * The id of the vendor session to record with the release, read after
	 * the last pass. The core records it under the executor kind. The room
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
	 * Release what the running activation holds, such as a process. The driver
	 * calls it once, after the release of the activation. A running activation
	 * that holds nothing leaves it out.
	 */
	close?(): void;
}

/**
 * Opens one activation of one seat. One opener per seat, for its whole
 * lifetime. The core records and resumes vendor sessions under the seat's
 * executor kind, `definition.executor.kind`.
 */
export type ActivationOpener = (activation: ExecutorActivation) => RunningActivation;

// -- a seat reaching its room -------------------------------------------------

/** Public participant facts with each person's recorded reading progress. */
export type ContextParticipant =
	| AgentParticipant
	| (HumanParticipant & {
			readonly changedAt?: string;
			readonly lastDeparture?: Seq;
			readonly messagesSinceDeparture: number;
	  });

/** Collaboration facts selected for one activation. Private executable definitions stay with the executor. */
export interface CollaborationContext {
	readonly name: string;
	readonly now: number;
	readonly goal?: string;
	readonly participants: readonly ContextParticipant[];
	readonly messages: readonly Without<Message, 'preferences'>[];
	/** The open exchange for an ordinary response. */
	readonly exchange?: { readonly person?: string; readonly from: Seq };
	/** Reserve identities are available to every responding agent. */
	readonly reserve: readonly { readonly name: string; readonly identity: string }[];
	/** Only the summary writer reads the preferences of the person it writes for. */
	readonly preferences?: string;
	/**
	 * The says of this seat that wait to return, for a response. The seq of
	 * each names it. Absent when none waits.
	 */
	readonly scheduled?: readonly ScheduledSay[];
	/**
	 * How many messages of the record this activation may read lie below the
	 * first one in `messages`. The room reports it when the cap or the token
	 * limit of the seat leaves a message out. Absent means none.
	 */
	readonly omitted?: number;
}

export interface ActivationView {
	/** The identity and purpose authorized by the room. */
	spec: ActivationSpec;
	/** The context boundary represented by this view. Consumption acknowledges it. */
	through: Seq;
	context: CollaborationContext;
	/**
	 * When the room ends this activation, whatever its renewals, in
	 * milliseconds since the epoch on the wall clock: `Date.now()` plus the
	 * time the room's own clock has left. A seat on another host reads its own
	 * wall clock, so a tool that waits keeps a margin for the skew between the
	 * two. A view that no room served has none.
	 */
	deadline?: number;
}

/** The request the lease answers is gone: the lease ended, or the room did. */
export interface Stale {
	stale: string;
}

export type ViewResponse = { view: ActivationView } | Stale;

/** The session the room recorded for this seat, when an executor of `kind` wrote it. */
export function sessionToResume(view: ActivationView, kind: string): string | undefined {
	const { resume } = view.spec;
	return resume?.kind === kind ? resume.id : undefined;
}

export type { Intent };

/** A membership change or a dismissal that the record already holds. */
export type Unchanged =
	{ kind: 'seated' | 'unseated'; name: string } | { kind: 'dismissed'; message: Seq };

export interface CommitRequest {
	activation: string;
	key: string;
	readThrough?: Seq;
	intent: Intent;
}

/**
 * What a seat's commit call resolves to. The room stamps every case but
 * `unknown`. A transport that loses the confirmation of a commit resolves the
 * call to `unknown`: the message may or may not have landed. The commit key
 * makes a retry safe, so the seat retries first and reports `unknown` only
 * when no attempt confirms.
 */
export type CommitResult =
	| {
			committed: Message;
			/**
			 * The messages a scheduled say landed past: after its `readThrough` and
			 * before the say. The room takes a scheduled say at any position.
			 */
			unread?: Message[];
	  }
	| { unchanged: Unchanged }
	| { missed: Message[] }
	| { refused: string }
	| { unknown: string }
	| Stale;

export type LeaseRequest =
	| { activation: string; operation: 'claim' }
	| { activation: string; operation: 'renew'; readThrough?: Seq }
	| ({ activation: string; operation: 'release' } & Pick<
			Static<typeof leaseEndedSchema>,
			'reason' | 'readThrough' | 'cause' | 'usage' | 'session'
	  >);

/**
 * The lease holds, with its expiry and the last place on the record. The seat
 * reads `through` against what its view held: the record moved when it grew.
 * An entry beside the record moves neither, so a renewal never reports its
 * own landing as movement.
 */
export type LeaseResponse = { ok: { expiresAt: number; through: Seq } } | Stale;

export interface RoomProtocol {
	/**
	 * The view of an activation. The room windows its record to the cap and
	 * to the token limit of the seat. With `message`, the view holds that one
	 * message alone, when the purpose may read it, and no window applies.
	 */
	view(activation: string, message?: Seq): Promise<ViewResponse>;
	commit(commit: CommitRequest): Promise<CommitResult>;
	lease(lease: LeaseRequest): Promise<LeaseResponse>;
}

// -- checks --------------------------------------------------------------------

/** The value as it comes back from the wire. */
export function roundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

const PLAIN = new Set(['Object', 'Array']);

/** Throws when a value would not survive the wire as it is. */
export function assertWire(value: unknown, path = '$'): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number.`);
		return;
	}
	if (typeof value !== 'object') throw new Error(`${path} is a ${typeof value}.`);
	const tag = (value as object).constructor?.name ?? 'Object';
	if (!PLAIN.has(tag)) throw new Error(`${path} is a ${tag}.`);
	for (const [key, item] of Object.entries(value as Record<string, unknown>))
		assertKey(item, `${path}.${key}`);
}

function assertKey(item: unknown, path: string): void {
	if (item === undefined) throw new Error(`${path} is undefined.`);
	assertWire(item, path);
}
