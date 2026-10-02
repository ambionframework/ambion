/**
 * The Claude opener: it opens one running activation, which takes each pass
 * the driver hands it until the activation stops.
 *
 * The Claude Agent SDK owns the loop. The driver's contract is pass in and
 * result out, so one activation opens one SDK query, kept alive by
 * streaming input. A pass pushes one user message, the rendered view or the
 * delta, and resolves on the SDK `result` that answers it.
 *
 * - **Freshness.** The core keeps `readThrough`. The activation tells it
 *   that the model read a range when the SDK echoes the user message back,
 *   and on nothing earlier. It tells the core that a tool result reached
 *   the model when the SDK reports that result.
 * - **Steer.** A line that lands mid-pass joins the streaming input, and
 *   its echo tells the core that the model read it. The core records the
 *   `steer` step ([`executors.md`](../../../docs/executors.md)), and a line
 *   with no echo waits for the next delta. A line that lands during the
 *   final answer runs as a turn of its own after the first `result`. Its
 *   echo arrives with that turn, so the pass settles on the later `result`.
 * - **Cut.** The signal of the activation interrupts the query. `close` ends
 *   the input and the process, and the driver calls it when the activation
 *   is over.
 * - **Exchange continuity.** The query persists its session on the local
 *   disk, and the release records the id the SDK reports. The activation
 *   resumes the session that `spec.resume` names, which the room hands back
 *   inside one exchange. A resumed session keeps its first system prompt,
 *   so the first message restates the seat's part. A resume the SDK cannot
 *   honor starts a fresh session, and the release records the new id.
 */
import type {
	ActivationOpener,
	AgentDefinition,
	ExecutorActivation,
	Pass,
	PassRecord,
	PassResult,
	ReadRange,
	RunningActivation,
	Seq,
} from '@ambionframework/ambion/hosting';
import { failedPass } from '@ambionframework/ambion/hosting';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSteps } from './claude-trace.ts';
import { floorRefusal, passResultOf, sessionOf, unresumableResult } from './failure.ts';
import { type SeatHome, seatHome } from './home.ts';
import { type ClaudeExecutionOptions, claudeOf, queryOptions } from './options.ts';
import { Echoes, Inbox, userMessage } from './steer.ts';
import { roomServer } from './tools.ts';

/** The head of the first message of a resumed query. The system prompt of the session is older. */
export const RESUMED_NOTE =
	'Your duties and instructions for this activation follow. Where they differ from the start of this session, follow these.';

/** How long a failed result waits for the end of the standard error, in milliseconds. */
const STDERR_DRAIN = 50;

/** How long a finished result waits for an echo the SDK owes, in milliseconds. */
const ECHO_GRACE = 5_000;

/** The most characters of standard error that a failure message holds. */
export const STDERR_TAIL = 2_000;

/** The end of what an executable wrote to its standard error. */
class Tail {
	private text = '';

	/** Add a chunk, and keep the last `STDERR_TAIL` characters. */
	add(data: string): void {
		this.text = (this.text + data).slice(-STDERR_TAIL);
	}

	/** A failure message with the tail after it. The message stands alone when the tail is empty. */
	append(message: string): string {
		const tail = this.text.trim();
		return tail === ''
			? message
			: `${message}\n\nThe standard error of the process ended with:\n${tail}`;
	}
}

/** What builds a Claude opener for one seat: its definition, and the options that run it. */
export interface ClaudeOpenerOptions extends ClaudeExecutionOptions {
	readonly definition: AgentDefinition;
	/** The room of the seat. It names the config directory. Absent, `room`. */
	readonly room?: string;
	/** The name of the seat. It names the config directory. Absent, the name of the definition. */
	readonly seat?: string;
	/** The SDK entry. Absent, the SDK's own `query`. */
	readonly query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

/** The Claude opener. One instance per seat, for as long as the room runs. */
export function createClaudeOpener(options: ClaudeOpenerOptions): ActivationOpener {
	// Every activation of the seat shares one config home, because a resume reads the session store there.
	const home = seatHome(
		options.configRoot,
		options.room ?? 'room',
		options.seat ?? options.definition.name,
	);
	return (activation: ExecutorActivation): RunningActivation =>
		new Activation(activation, options, home);
}

/** A steered line held until its pass sends its prompt. */
interface Held {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

/** One activation, from the moment the room wakes a seat until it stops. */
class Activation implements RunningActivation {
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly options: ClaudeExecutionOptions;
	private readonly home: SeatHome;
	private readonly open: NonNullable<ClaudeOpenerOptions['query']>;
	private readonly steps = new ClaudeSteps();
	private inbox = new Inbox();
	private readonly echoes = new Echoes();
	/** The steers held until the pass sends its prompt. */
	private held: Held[] = [];
	/** The messages sent and not yet echoed. A restart of the query sends them again. */
	private readonly outbox = new Map<string, SDKUserMessage>();
	/** The session the SDK reported last. */
	private reported: string | undefined;
	/** The session this activation asked the SDK to resume. */
	private resuming: string | undefined;
	/** Whether the query has sent any message. */
	private heard = false;
	/** Opens the query. Set on the first pass. */
	private begin: (() => Query) | undefined;
	private stream: Query | undefined;
	/** The end of the standard error of the current query. */
	private tail = new Tail();
	/** Set while a pass waits for its result. It settles the pass. */
	private settle: ((result: PassResult) => void) | undefined;
	private grace: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The result that waits on `grace` to settle the pass. The end of the
	 * stream, a throw, or `close` settles the pass with it at once, so the
	 * exit of the process cannot replace its cause. The echo that it waits
	 * for drops a result that did not fail: the turn of that echo answers
	 * next.
	 */
	private parked: PassResult | undefined;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: ClaudeOpenerOptions, home: SeatHome) {
		this.activation = activation;
		this.definition = options.definition;
		this.options = options;
		this.home = home;
		this.open = options.query ?? query;
		activation.signal.addEventListener('abort', () => this.abort(), { once: true });
	}

	/** The id of the Claude session to record with the release. Absent until the SDK reports one. */
	get session(): string | undefined {
		return this.reported;
	}

	/** The sink for the steps this executor owns. */
	private get trace() {
		return this.activation.trace;
	}

	/**
	 * A line landed while a pass runs. Until the pass sends its prompt, the
	 * line waits: the pass sends it right after the prompt. Once the pass sent
	 * its prompt, the line joins the input, and the echo confirms it. A line
	 * still held when the pass settles waits for the next delta.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.settle === undefined) this.held.push({ after, seq, line });
		else this.send(line, { after, through: seq });
	}

	/** The activation was cut: interrupt the query. The pass in flight ends. */
	private abort(): void {
		this.stopped = true;
		this.stream?.interrupt().catch(() => {});
		this.finish({ failed: false });
	}

	/** End the input and the process. The driver calls this once the activation is over. */
	close(): void {
		this.settleParked();
		this.stopped = true;
		this.inbox.end();
		clearTimeout(this.grace);
		this.stream?.close();
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(pass: Pass): Promise<PassResult> {
		try {
			const prompt = await this.promptFor(pass);
			if (prompt === undefined) return { failed: false };
			const done = new Promise<PassResult>((resolve) => {
				this.settle = resolve;
			});
			this.start(pass);
			this.send(prompt.text, prompt.range);
			this.flush();
			return await done;
		} catch (error) {
			return failedPass(error);
		} finally {
			this.settle = undefined;
			// A line the query never took waits for the next delta.
			this.held = [];
			clearTimeout(this.grace);
			this.parked = undefined;
		}
	}

	/**
	 * The message that starts a pass: the whole view first, then the delta,
	 * or none when nothing is new. A resumed session keeps the system prompt
	 * it began with, so the first message of a resumed query restates the
	 * seat's part for this activation. A summary activation gets its duties
	 * and the reader's preferences this way.
	 */
	private async promptFor(pass: Pass): Promise<PassRecord | undefined> {
		const record = await pass.record();
		if (record === undefined || pass.kind === 'delta') return record;
		const resumes = this.stream === undefined && pass.resumeId !== undefined;
		return resumes
			? { ...record, text: `${RESUMED_NOTE}\n\n${pass.agent}\n\n${record.text}` }
			: record;
	}

	/** The steers held until the pass sent its prompt join the input. */
	private flush(): void {
		for (const held of this.held.splice(0)) {
			this.send(held.line, { after: held.after, through: held.seq });
		}
	}

	/** Push one user message into the input. Its echo tells the core that the model read its range. */
	private send(text: string, range: ReadRange): void {
		const uuid = crypto.randomUUID();
		this.echoes.expect(uuid, range);
		const message = userMessage(text, uuid);
		this.outbox.set(uuid, message);
		this.inbox.push(message);
	}

	/** Open the query on the first pass. Later passes keep it. */
	private start(pass: Pass): void {
		if (this.stream !== undefined) return;
		const executor = claudeOf(this.definition.executor);
		this.resuming = pass.resumeId;
		this.begin = () => {
			// Each query takes its own room server. A server serves one connection.
			const { server, names } = roomServer(pass.tools, (tool) => this.activation.callId(tool));
			// A restart opens a query with a tail of its own. The old query can write no more into it.
			const tail = new Tail();
			this.tail = tail;
			return this.open({
				prompt: this.inbox,
				options: queryOptions({
					executor,
					systemPrompt: `${pass.mechanism}\n\n${pass.agent}`,
					server,
					names,
					options: this.options,
					home: this.home,
					stderr: (data) => tail.add(data),
					...(this.resuming === undefined ? {} : { resume: this.resuming }),
				}),
			});
		};
		const stream = this.begin();
		this.stream = stream;
		void this.consume(stream);
	}

	/**
	 * Start the query again without the session it could not resume. The
	 * messages that wait for an echo go to the new input. It clears
	 * `resuming`, so the restart happens once.
	 */
	private restart(begin: () => Query): void {
		this.resuming = undefined;
		this.reported = undefined;
		this.inbox.end();
		this.inbox = new Inbox();
		for (const message of this.outbox.values()) this.inbox.push(message);
		const stream = begin();
		this.stream = stream;
		void this.consume(stream);
	}

	/** Read the query to its end. An end or an error before the pass settles is a failure of the pass. */
	private async consume(stream: Query): Promise<void> {
		try {
			for await (const message of stream) this.handle(message);
			// A restart replaced this stream. Its end says nothing about the pass.
			if (stream !== this.stream) return;
			if (this.settleParked()) return;
			this.finish({
				failed: true,
				cause: 'transient',
				message: this.tail.append('The Claude session ended before the pass did.'),
			});
		} catch (error) {
			this.threw(stream, error);
		}
	}

	/** The query threw. A resume the SDK cannot honor can end the stream before any message. */
	private threw(stream: Query, error: unknown): void {
		if (this.stopped || stream !== this.stream) return;
		if (this.settleParked()) return;
		// The SDK also reports an unresumable session as an error result, which `answered` handles.
		if (this.begin !== undefined && this.resumeFailed()) {
			this.restart(this.begin);
			return;
		}
		this.finish(this.withTail(failedPass(error)));
	}

	/**
	 * A failed result with the end of the standard error in its message. The
	 * cause and the error stay as they were, so the text of the process never
	 * changes how the core classifies the failure. A pass that did not fail
	 * stays as it is.
	 */
	private withTail(result: PassResult): PassResult {
		return result.failed && result.message !== undefined
			? { ...result, message: this.tail.append(result.message) }
			: result;
	}

	/** Whether a resumed query threw before it said anything. */
	private resumeFailed(): boolean {
		return this.resuming !== undefined && !this.heard;
	}

	/** One SDK message: its steps, its echo, and, for a result, the end of the pass. */
	private handle(message: SDKMessage): void {
		this.heard = true;
		const session = sessionOf(message);
		if (session !== undefined) this.reported = session;
		for (const step of this.steps.steps(message)) {
			this.trace.record(step);
			// The SDK reports a tool result as the model reads it next.
			if (step.type === 'tool_result') this.activation.delivered(step.call);
		}
		if (message.type === 'system' && message.subtype === 'init') this.checked(message);
		if (message.type === 'user') this.echoed(message);
		if (message.type === 'result') this.answered(message);
	}

	/**
	 * The init message names the version of the executable. An executable
	 * below the floor would read files that user text names, so the pass
	 * fails at once and the query closes before any model turn runs. The
	 * `session` step is already recorded.
	 */
	private checked(init: Extract<SDKMessage, { type: 'system'; subtype: 'init' }>): void {
		const refusal = floorRefusal(init.claude_code_version);
		if (refusal === undefined) return;
		this.finish(refusal);
		this.stopped = true;
		this.inbox.end();
		this.stream?.close();
	}

	/**
	 * The SDK sent a user message back: the model has it, so the core counts
	 * its range read. A result that did not fail and waits on the grace timer
	 * ended the turn before this message. The message starts the next turn, so
	 * the echo cancels the timer and drops that result. The pass settles on
	 * the result of the next turn. A failed result keeps its timer, because
	 * the timer lets the standard error arrive.
	 */
	private echoed(message: Extract<SDKMessage, { type: 'user' }>): void {
		const range = this.echoes.confirm(message.uuid);
		if (range === undefined) return;
		if (message.uuid !== undefined) this.outbox.delete(message.uuid);
		this.activation.read(range);
		if (this.parked !== undefined && !this.parked.failed) {
			clearTimeout(this.grace);
			this.parked = undefined;
		}
	}

	/**
	 * A result ends the pass when no sent message still waits for its echo and
	 * no queued message follows. Otherwise the result waits on the grace timer,
	 * and the echo of the message cancels the timer; see `echoed`. The timer
	 * ends the pass with the result when no echo comes.
	 */
	private answered(message: Extract<SDKMessage, { type: 'result' }>): void {
		if (this.stopped) return;
		if (this.resuming !== undefined && this.begin !== undefined && unresumableResult(message)) {
			this.restart(this.begin);
			return;
		}
		const more = this.echoes.waiting > 0 || (message.queued_turn_count ?? 0) > 0;
		this.settleWith(passResultOf(message), more ? ECHO_GRACE : 0);
	}

	/**
	 * Settle the pass with a result after `delay` milliseconds. A failed
	 * result waits a moment more, because the standard error comes on a pipe
	 * of its own and can trail the result. The message then holds its tail.
	 * A parked result that did not fail does not settle the pass when an echo
	 * arrives first; see `echoed`.
	 */
	private settleWith(result: PassResult, delay: number): void {
		clearTimeout(this.grace);
		const wait = result.failed ? delay + STDERR_DRAIN : delay;
		if (wait === 0) {
			this.finish(result);
			return;
		}
		this.parked = result;
		this.grace = setTimeout(() => this.settleParked(), wait);
		this.grace.unref();
	}

	/** Settle the pass with the parked result, and say whether one waited. */
	private settleParked(): boolean {
		const parked = this.parked;
		if (parked === undefined) return false;
		this.finish(this.withTail(parked));
		return true;
	}

	/** Settle the pass in flight. The core reports a failure. */
	private finish(result: PassResult): void {
		this.parked = undefined;
		clearTimeout(this.grace);
		const settle = this.settle;
		if (settle === undefined) return;
		this.settle = undefined;
		settle(result);
	}
}
