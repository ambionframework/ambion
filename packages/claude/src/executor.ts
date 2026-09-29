/**
 * The Claude executor: one activation's session, from the pass the driver
 * hands it until the activation stops.
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
 * - **Steer.** A line that lands mid-pass joins the streaming input. The
 *   activation records it as consumed on its echo. A steer that finds no
 *   pass in flight waits for the record: the next delta carries it.
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
	AgentDefinition,
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
	PassRecord,
	PassResult,
	ReadRange,
	Seq,
} from '@ambionframework/ambion/hosting';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSteps } from './claude-trace.ts';
import { approver, type ClaudeRuntime, claudeOf, queryOptions } from './options.ts';
import { passResultOf, sessionOf, unresumableResult } from './services.ts';
import { Echoes, Inbox, userMessage } from './steer.ts';
import { roomServer } from './tools.ts';

/** The head of the first message of a resumed query. The system prompt of the session is older. */
export const RESUMED_NOTE =
	'Your duties and instructions for this activation follow. Where they differ from the start of this session, follow these.';

/** How long a finished result waits for an echo the SDK owes, in milliseconds. */
const ECHO_GRACE = 5_000;

/** What builds a Claude executor for one seat: its definition, and the runtime that runs it. */
export interface ClaudeExecutorOptions extends ClaudeRuntime {
	readonly definition: AgentDefinition;
	/** The SDK entry. Absent, the SDK's own `query`. */
	readonly query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

/** The Claude executor. One instance per seat, for as long as the room runs. */
export function createClaudeExecutor(options: ClaudeExecutorOptions): Executor {
	return {
		harness: 'claude',
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options);
		},
	};
}

/** A steered line held until its pass starts. */
interface Held {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

/** One activation, from the moment the room wakes a seat until it stops. */
class Activation implements ExecutorSession {
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly runtime: ClaudeRuntime;
	private readonly open: NonNullable<ClaudeExecutorOptions['query']>;
	private readonly steps = new ClaudeSteps();
	private inbox = new Inbox();
	private readonly echoes = new Echoes();
	/** The steers held before the query starts. */
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
	/** Set while a pass waits for its result. It settles the pass. */
	private settle: ((result: PassResult) => void) | undefined;
	private grace: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: ClaudeExecutorOptions) {
		this.activation = activation;
		this.definition = options.definition;
		this.runtime = options;
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
	 * A line landed while this activation worked. A pass in flight takes it
	 * into the input, and the echo confirms it. Before the first pass it
	 * waits. Between passes it waits for the record: the next delta has it.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.stream === undefined) {
			this.held.push({ after, seq, line });
		} else if (this.settle === undefined) {
			this.trace.record({ type: 'steer', seq, consumed: false });
		} else {
			this.send(line, { range: { after, through: seq }, steer: true });
		}
	}

	/** The activation was cut: interrupt the query. The pass in flight ends. */
	private abort(): void {
		this.stopped = true;
		this.stream?.interrupt().catch(() => {});
		this.finish({ failed: false });
	}

	/** End the input and the process. The driver calls this once the activation is over. */
	close(): void {
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
			this.send(prompt.text, { range: prompt.range, steer: false });
			this.flush(pass.view.through);
			return await done;
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.settle = undefined;
			clearTimeout(this.grace);
		}
	}

	/**
	 * The message that starts a pass: the whole view first, then the delta,
	 * or none when nothing is new. A resumed session keeps the system prompt
	 * it began with, so the first message of a resumed query restates the
	 * seat's part for this activation. A closing activation gets its duties
	 * and the reader's preferences this way.
	 */
	private async promptFor(pass: Pass): Promise<PassRecord | undefined> {
		const record = await pass.record();
		if (record === undefined || pass.kind === 'delta') return record;
		const resumes = this.stream === undefined && pass.resume !== undefined;
		return resumes
			? { ...record, text: `${RESUMED_NOTE}\n\n${pass.agent}\n\n${record.text}` }
			: record;
	}

	/**
	 * The steers held before the query started. A line the view already
	 * holds reached the model as part of it. Any other joins the input.
	 */
	private flush(through: Seq): void {
		for (const held of this.held.splice(0)) {
			if (held.seq <= through) {
				this.trace.record({ type: 'steer', seq: held.seq, consumed: true });
			} else {
				this.send(held.line, { range: { after: held.after, through: held.seq }, steer: true });
			}
		}
	}

	/** Push one user message into the input. Its echo tells the core that the model read its range. */
	private send(text: string, sent: { range: ReadRange; steer: boolean }): void {
		const uuid = crypto.randomUUID();
		this.echoes.expect(uuid, sent);
		const message = userMessage(text, uuid);
		this.outbox.set(uuid, message);
		this.inbox.push(message);
	}

	/** Open the query on the first pass. Later passes keep it. */
	private start(pass: Pass): void {
		if (this.stream !== undefined) return;
		const executor = claudeOf(this.definition.executor);
		const tools = [...pass.tools, ...pass.agentTools];
		this.resuming = pass.resume;
		this.begin = () => {
			// Each query takes its own room server. A server serves one connection.
			const { server, names } = roomServer(tools, (tool) => this.activation.callId(tool));
			return this.open({
				prompt: this.inbox,
				options: queryOptions({
					executor,
					systemPrompt: `${pass.mechanism}\n\n${pass.agent}`,
					server,
					names,
					canUseTool: approver(executor, this.trace, names),
					runtime: this.runtime,
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
			this.finish({
				failed: true,
				cause: 'transient',
				message: 'The Claude session ended before the pass did.',
			});
		} catch (error) {
			this.threw(stream, error);
		}
	}

	/** The query threw. A resume the SDK cannot honor can end the stream before any message. */
	private threw(stream: Query, error: unknown): void {
		if (this.stopped || stream !== this.stream) return;
		// The SDK also reports an unresumable session as an error result, which `answered` handles.
		if (this.begin !== undefined && this.resumeFailed()) {
			this.restart(this.begin);
			return;
		}
		this.finish(this.broke(error instanceof Error ? error : new Error(String(error))));
	}

	/** Whether a resumed query threw before it said anything. */
	private resumeFailed(): boolean {
		return this.resuming !== undefined && !this.heard;
	}

	/** One SDK message: its steps, its echo, and, for a result, the end of the pass. */
	private handle(message: SDKMessage): void {
		this.heard = true;
		const session = sessionOf(message);
		if (session !== undefined) this.reported = session.id;
		for (const step of this.steps.steps(message)) {
			this.trace.record(step);
			// The SDK reports a tool result as the model reads it next.
			if (step.type === 'tool_result') this.activation.delivered(step.call);
		}
		if (message.type === 'user') this.echoed(message);
		if (message.type === 'result') this.answered(message);
	}

	/** The SDK sent a user message back: the model has it, so the core counts its range read. */
	private echoed(message: Extract<SDKMessage, { type: 'user' }>): void {
		const sent = this.echoes.confirm(message.uuid);
		if (sent === undefined) return;
		if (message.uuid !== undefined) this.outbox.delete(message.uuid);
		this.activation.read(sent.range);
		if (sent.steer) this.trace.record({ type: 'steer', seq: sent.range.through, consumed: true });
	}

	/**
	 * A result ends the pass when no sent message still waits for its echo and
	 * no queued turn follows. Otherwise the pass waits for that turn's result.
	 */
	private answered(message: Extract<SDKMessage, { type: 'result' }>): void {
		if (this.stopped) return;
		if (this.resuming !== undefined && this.begin !== undefined && unresumableResult(message)) {
			this.restart(this.begin);
			return;
		}
		const more = this.echoes.waiting > 0 || (message.queued_turn_count ?? 0) > 0;
		if (!more) {
			this.finish(passResultOf(message));
			return;
		}
		clearTimeout(this.grace);
		this.grace = setTimeout(() => this.finish(passResultOf(message)), ECHO_GRACE);
		this.grace.unref();
	}

	/** Settle the pass in flight. The core reports a failure. */
	private finish(result: PassResult): void {
		const settle = this.settle;
		if (settle === undefined) return;
		this.settle = undefined;
		settle(result);
	}

	/**
	 * The result for a fault of this executor, such as a lost process or a
	 * build error. It is transient, so the room tries the activation again.
	 */
	private broke(error: Error): PassResult {
		return { failed: true, cause: 'transient', message: error.message, error };
	}
}
