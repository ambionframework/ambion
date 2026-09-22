/**
 * The Claude executor: one activation's session, from the pass the driver
 * hands it until the activation stops.
 *
 * The Claude Agent SDK owns the loop. The driver's contract is pass in and
 * result out, so one activation opens one SDK query, kept alive by
 * streaming input. A pass pushes one user message, the rendered view or the
 * delta, and resolves on the SDK `result` that answers it.
 *
 * - **Freshness.** `readThrough` advances when the SDK echoes a user
 *   message back, and on nothing earlier. A say never commits against
 *   record the model has not read. A tool result that carries missed
 *   messages advances it when the SDK reports that result.
 * - **Steer.** A line that lands mid-pass joins the streaming input. The
 *   activation records it as consumed on its echo. A steer that finds no
 *   pass in flight waits for the record: the next delta carries it.
 * - **Cut.** `abort` interrupts the query. `close` ends the input and the
 *   process, and the driver calls it when the activation is over.
 * - **Memory.** With `memory: 'seat'` the query persists its session and
 *   the executor keeps the id the SDK reports. The next activation resumes
 *   it. After a restart the id comes from `spec.resume`, which the room
 *   read off the journal. A resume the SDK cannot honor starts a fresh
 *   session, and the release records the new id.
 */
import type {
	ActivationView,
	AgentDefinition,
	Executor,
	ExecutorActivation,
	ExecutorSession,
	HarnessSession,
	PassInput,
	PassResult,
	RoomProtocol,
	Seq,
	TraceSink,
} from '@ambionframework/ambion/hosting';
import {
	renderActivation,
	renderDelta,
	resumesForSeat,
	sessionToResume,
} from '@ambionframework/ambion/hosting';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeSteps, plainName } from './claude-trace.ts';
import { approver, type ClaudeRuntime, claudeOf, queryOptions } from './options.ts';
import { passResultOf, sessionOf, unresumableResult } from './services.ts';
import { Echoes, Inbox, userMessage } from './steer.ts';
import { type Binding, roomServer } from './tools.ts';

/** How long a finished result waits for an echo the SDK owes, in milliseconds. */
const ECHO_GRACE = 5_000;

/** What builds a Claude executor for one seat: its definition, and the runtime that runs it. */
export interface ClaudeExecutorOptions extends ClaudeRuntime {
	readonly definition: AgentDefinition;
	/** The SDK entry. Absent, the SDK's own `query`. */
	readonly query?: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => Query;
}

/** What a seat with memory keeps between activations: the session the SDK reported last. */
interface SeatMemory {
	id?: string;
}

/** The Claude executor. One instance per seat, for as long as the room runs. */
export function createClaudeExecutor(options: ClaudeExecutorOptions): Executor {
	const memory: SeatMemory | undefined = resumesForSeat(options.definition.executor)
		? {}
		: undefined;
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options, memory);
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
	readonly id: string;
	private readonly room: RoomProtocol;
	private readonly emit: ExecutorActivation['emit'];
	private readonly trace: TraceSink;
	private readonly definition: AgentDefinition;
	private readonly runtime: ClaudeRuntime;
	private readonly open: NonNullable<ClaudeExecutorOptions['query']>;
	private readonly steps = new ClaudeSteps();
	private inbox = new Inbox();
	private readonly echoes = new Echoes();
	/** Aborts when the activation is cut. The tools read its signal. */
	private readonly cut = new AbortController();
	/** Tool results that carry record the model has not read yet, by call id. */
	private readonly expected = new Map<string, Seq>();
	/** The names of the tools in flight, by call id. */
	private readonly named = new Map<string, string>();
	/** The steers held before the query starts. */
	private held: Held[] = [];
	/** The messages sent and not yet echoed. A restart of the query sends them again. */
	private readonly outbox = new Map<string, SDKUserMessage>();
	/** The seat's memory across activations. Absent when the seat keeps none. */
	private readonly memory: SeatMemory | undefined;
	/** The session this activation asked the SDK to resume. */
	private resuming: string | undefined;
	/** Whether the query has sent any message. */
	private heard = false;
	/** Opens the query. Set on the first pass. */
	private begin: (() => Query) | undefined;
	private through = 0;
	private stream: Query | undefined;
	/** Set while a pass waits for its result. It settles the pass. */
	private settle: ((result: PassResult) => void) | undefined;
	private grace: ReturnType<typeof setTimeout> | undefined;
	private view: ActivationView | undefined;
	private serial = 0;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: ClaudeExecutorOptions, memory?: SeatMemory) {
		this.id = activation.id;
		this.room = activation.room;
		this.emit = activation.emit;
		this.trace = activation.trace;
		this.definition = options.definition;
		this.runtime = options;
		this.open = options.query ?? query;
		this.memory = memory;
	}

	/** The Claude session to record with the release. Absent until the SDK reports one, and when the seat keeps no memory. */
	get session(): HarnessSession | undefined {
		const id = this.memory?.id;
		return id === undefined ? undefined : { harness: 'claude', id };
	}

	/** The seq this activation may commit against: the freshness boundary `readThrough`. */
	get readThrough(): Seq {
		return this.through;
	}

	/** Whether `abort` was called. The driver checks this before another room round trip. */
	get cancelled(): boolean {
		return this.stopped;
	}

	/**
	 * A line landed while this activation worked. A pass in flight takes it
	 * into the input, and the echo confirms it. Before the first pass it
	 * waits. Between passes it waits for the record: the next delta has it.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.stopped) return;
		if (this.stream === undefined) {
			this.held.push({ after, seq, line });
		} else if (this.settle === undefined) {
			this.trace.record({ type: 'steer', seq, consumed: false });
		} else {
			this.send(line, { through: seq, steer: { after } });
		}
	}

	/** Whether the record moved past what the model read. */
	shouldRefresh(lastSeq: Seq): boolean {
		return !this.stopped && lastSeq > this.through;
	}

	/** Interrupt the query. The pass in flight ends, and the driver runs no other. */
	abort(): void {
		this.stopped = true;
		this.cut.abort();
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
	async pass(input: PassInput): Promise<PassResult> {
		try {
			if (this.stopped) return { failed: false };
			this.view = input.view;
			const prompt = this.promptFor(input);
			if (prompt === undefined) {
				this.through = Math.max(this.through, input.view.through);
				return { failed: false };
			}
			const done = new Promise<PassResult>((resolve) => {
				this.settle = resolve;
			});
			this.start(input.view);
			this.send(prompt, { through: input.view.through });
			this.flush(input.view.through);
			return await done;
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.settle = undefined;
			clearTimeout(this.grace);
		}
	}

	/** The message that starts a pass: the whole view first, then the delta, or none when nothing is new. */
	private promptFor(input: PassInput): string | undefined {
		if (input.kind === 'view') return renderActivation(input.view, this.definition).context;
		return renderDelta(input.view, input.since);
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
				this.send(held.line, { through: held.seq, steer: { after: held.after } });
			}
		}
	}

	/** Push one user message into the input, and wait for its echo to advance `readThrough`. */
	private send(text: string, sent: { through: Seq; steer?: { after: Seq } }): void {
		this.serial += 1;
		const uuid = crypto.randomUUID();
		this.echoes.expect(uuid, sent);
		const message = userMessage(text, uuid);
		this.outbox.set(uuid, message);
		this.inbox.push(message);
	}

	/** Open the query on the first pass. Later passes keep it. */
	private start(view: ActivationView): void {
		if (this.stream !== undefined) return;
		if (view.spec.seat !== this.definition.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		const { mechanism, agent } = renderActivation(view, this.definition);
		const executor = claudeOf(this.definition.executor);
		this.resuming =
			this.memory === undefined ? undefined : (this.memory.id ?? sessionToResume(view, 'claude'));
		this.begin = () => {
			// Each query takes its own room server. A server serves one connection.
			const { server, names } = roomServer(view, this.definition, this.binding(), () =>
				this.currentView(view),
			);
			return this.open({
				prompt: this.inbox,
				options: queryOptions({
					executor,
					systemPrompt: `${mechanism}\n\n${agent}`,
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
		if (this.memory !== undefined) this.memory.id = undefined;
		this.inbox.end();
		this.inbox = new Inbox();
		for (const message of this.outbox.values()) this.inbox.push(message);
		const stream = begin();
		this.stream = stream;
		void this.consume(stream);
	}

	/** What the room tools reach. */
	private binding(): Binding {
		const read = () => this.through;
		return {
			id: this.id,
			room: this.room,
			get readThrough() {
				return read();
			},
			signal: this.cut.signal,
			acknowledgeThrough: (seq) => this.advance(seq),
			resultExpected: (call, seq) => {
				this.expected.set(call, seq);
			},
			callId: (tool) => this.steps.claim(tool) ?? `${this.id}:${tool}:${this.serial++}`,
			abort: () => this.abort(),
		};
	}

	private currentView(built: ActivationView): ActivationView {
		return this.view ?? built;
	}

	private advance(seq: Seq): void {
		this.through = Math.max(this.through, seq);
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
		if (session !== undefined && this.memory !== undefined) this.memory.id = session.id;
		for (const step of this.steps.steps(message)) {
			this.trace.record(step);
			if (step.type === 'tool_call') this.started(step.call, step.name);
			if (step.type === 'tool_result') this.finished(step.call);
		}
		if (message.type === 'user') this.echoed(message);
		if (message.type === 'result') this.answered(message);
	}

	private started(call: string, name: string): void {
		this.named.set(call, name);
		// `say` is the room's own event, not a tool's.
		if (name !== 'say') this.toolEvent('tool_execution_start', name);
	}

	private finished(call: string): void {
		const name = this.named.get(call);
		this.named.delete(call);
		const seq = this.expected.get(call);
		if (seq !== undefined) this.advance(seq);
		this.expected.delete(call);
		if (name !== undefined && name !== 'say') this.toolEvent('tool_execution_end', name);
	}

	private toolEvent(type: 'tool_execution_start' | 'tool_execution_end', name: string): void {
		this.emit({
			type,
			agent: this.definition.name,
			activation: this.id,
			toolName: plainName(name),
		});
	}

	/** The SDK sent a user message back: the model has it, so the position advances. */
	private echoed(message: Extract<SDKMessage, { type: 'user' }>): void {
		const sent = this.echoes.confirm(message.uuid);
		if (sent === undefined) return;
		if (message.uuid !== undefined) this.outbox.delete(message.uuid);
		const contiguous = sent.steer === undefined || sent.steer.after <= this.through;
		if (contiguous) this.advance(sent.through);
		if (sent.steer !== undefined) {
			this.trace.record({ type: 'steer', seq: sent.through, consumed: true });
		}
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

	/** Settle the pass in flight. A failure reaches the host as an `error` event first. */
	private finish(result: PassResult): void {
		const settle = this.settle;
		if (settle === undefined) return;
		this.settle = undefined;
		if (result.failed && result.message !== undefined && !this.stopped) {
			this.emit({
				type: 'error',
				agent: this.definition.name,
				activation: this.id,
				error: new Error(result.message),
				...(result.cause === undefined ? {} : { cause: result.cause }),
			});
		}
		settle(result);
	}

	/**
	 * Record a fault of this executor, such as a lost process or a build
	 * error. It is transient, so the room tries the activation again.
	 */
	private broke(error: Error): PassResult {
		this.emit({
			type: 'error',
			agent: this.definition.name,
			activation: this.id,
			error,
			cause: 'transient',
		});
		return { failed: true, cause: 'transient', message: error.message };
	}
}
