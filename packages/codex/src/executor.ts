/**
 * The Codex executor: one activation's session, from the pass the driver
 * hands it until the activation stops.
 *
 * The Codex SDK owns the loop. One activation holds one Codex thread. A
 * pass runs one turn of it: the first pass sends the whole view, and a
 * later pass sends the delta. A turn ends on `turn.completed` or
 * `turn.failed`.
 *
 * - **Room tools.** The room tools live in a stdio MCP server that Codex
 *   spawns. The server reaches the room through a local socket that the
 *   activation opens (`bridge.ts`).
 * - **Freshness.** Codex sends no echo. The model reads the prompt when a
 *   turn starts, so `readThrough` moves to the view's position on
 *   `turn.started`. A say that the room answers `missed` moves it to the
 *   last missed line, which the model reads in the same tool result.
 * - **Memory.** With `memory: 'seat'` the executor keeps the thread id
 *   that `thread.started` reports. The next activation resumes that
 *   thread. After a restart the id comes from `spec.resume`, which the room
 *   read off the journal. A resume that Codex cannot honor fails before
 *   `thread.started`, and the activation starts a fresh thread instead.
 * - **Steer.** The session has no `steer`. Codex takes no message into a
 *   turn that runs. The driver holds the line, and the next pass reads it.
 * - **Cut.** `abort` signals the turn. `close` stops the socket and the
 *   room tools server.
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
import { renderActivation, renderDelta } from '@ambionframework/ambion/hosting';
import {
	Codex,
	type CodexOptions,
	type ThreadEvent,
	type ThreadOptions,
	type TurnOptions,
} from '@openai/codex-sdk';
import { type Bridge, startBridge } from './bridge.ts';
import {
	type CatalogSource,
	installedCatalog,
	PermanentError,
	type Scratch,
	scratchFor,
} from './catalog.ts';
import { CodexSteps, changedPaths, isRoomTool } from './codex-trace.ts';
import { type CodexRuntime, clientOptions, codexOf, threadOptions } from './options.ts';
import { passResultOf } from './services.ts';
import type { Binding } from './tools.ts';

/** What a seat with memory keeps between activations: the thread id Codex reported last. */
interface SeatMemory {
	id?: string;
}

/** Whether the executor resumes one thread for the seat. */
function remembers(definition: AgentDefinition): boolean {
	return 'memory' in definition.executor && definition.executor.memory === 'seat';
}

/** The thread the room recorded for this seat, when a Codex activation ended with one. */
function resumeOf(view: ActivationView): string | undefined {
	const { resume } = view.spec;
	return resume?.harness === 'codex' ? resume.id : undefined;
}

/** The part of a Codex thread that a pass uses. */
interface CodexThreadLike {
	runStreamed(
		input: string,
		options?: TurnOptions,
	): Promise<{ readonly events: AsyncIterable<ThreadEvent> }>;
}

/** The part of the Codex client that an activation uses. */
interface CodexClientLike {
	startThread(options?: ThreadOptions): CodexThreadLike;
	resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

/** What builds a Codex executor for one seat: its definition, and the runtime that runs it. */
export interface CodexExecutorOptions extends CodexRuntime {
	readonly definition: AgentDefinition;
	/** Builds the client. Absent, the SDK's own `Codex`. */
	readonly client?: (options: CodexOptions) => CodexClientLike;
	/** Answers the catalog entry of a model. Absent, `codex debug models` on the installed binary. */
	readonly catalog?: CatalogSource;
}

/**
 * Codex answers in its own final message when a prompt does not say
 * otherwise. The room hears only `say`, so the first prompt of each
 * activation says so.
 */
export const HARNESS_NOTE =
	'You are a seat in a room. Your final reply in this thread reaches no one. ' +
	'The room hears only what you send through the `say` tool, so answer with `say`, then stop.';

/** The Codex executor. One instance per seat, for as long as the room runs. */
export function createCodexExecutor(options: CodexExecutorOptions): Executor {
	const memory: SeatMemory | undefined = remembers(options.definition) ? {} : undefined;
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options, memory);
		},
	};
}

/**
 * How one turn ended. A turn ends on `turn.completed` or `turn.failed`.
 * Codex also sends `error` events for trouble it survives, such as a
 * reconnect, so an `error` event ends the turn only when nothing else does.
 */
class Ending {
	private complete = false;
	private failed: string | undefined;
	private notice: string | undefined;

	/** Take one event. It answers whether the turn is over. */
	over(event: ThreadEvent): boolean {
		if (event.type === 'error') this.notice = event.message;
		if (event.type === 'turn.failed') this.failed = event.error.message;
		this.complete = event.type === 'turn.completed';
		return this.complete || this.failed !== undefined;
	}

	/** The text of the failure, or nothing when the turn completed. */
	failure(): string | undefined {
		if (this.complete) return undefined;
		return this.failed ?? this.notice ?? 'The Codex session ended before the turn did.';
	}
}

/** One activation, from the moment the room wakes a seat until it stops. */
class Activation implements ExecutorSession {
	readonly id: string;
	private readonly room: RoomProtocol;
	private readonly emit: ExecutorActivation['emit'];
	private readonly trace: TraceSink;
	private readonly definition: AgentDefinition;
	private readonly options: CodexExecutorOptions;
	/** The seat's memory across activations. Absent when the seat keeps none. */
	private readonly memory: SeatMemory | undefined;
	/** The thread this activation asked Codex to resume. Cleared when the resume fails. */
	private resuming: string | undefined;
	/** Whether Codex reported `thread.started` for the thread in use. */
	private heard = false;
	private client: CodexClientLike | undefined;
	private readonly steps = new CodexSteps();
	/** Aborts when the activation is cut. The tools read its signal. */
	private readonly cut = new AbortController();
	/** Aborts the turn in flight. A turn that ended holds none, so a late cut never signals a dead process. */
	private turn: AbortController | undefined;
	/** The names of the tools in flight, by call id. */
	private readonly named = new Map<string, string>();
	private through = 0;
	/** Where the turn in flight reads through. It takes effect when the turn starts. */
	private reading = 0;
	private bridge: Bridge | undefined;
	/** The patched catalog and the empty directory. Absent when nativeTools is 'codex'. */
	private scratch: Scratch | undefined;
	private thread: CodexThreadLike | undefined;
	private view: ActivationView | undefined;
	private serial = 0;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: CodexExecutorOptions, memory?: SeatMemory) {
		this.id = activation.id;
		this.room = activation.room;
		this.emit = activation.emit;
		this.trace = activation.trace;
		this.definition = options.definition;
		this.options = options;
		this.memory = memory;
	}

	/** The Codex thread to record with the release. Absent until Codex reports one, and when the seat keeps no memory. */
	get session(): HarnessSession | undefined {
		const id = this.memory?.id;
		return id === undefined ? undefined : { harness: 'codex', id };
	}

	/** The seq this activation may commit against: the freshness boundary `readThrough`. */
	get readThrough(): Seq {
		return this.through;
	}

	/** Whether `abort` was called. The driver checks this before another room round trip. */
	get cancelled(): boolean {
		return this.stopped;
	}

	/** Whether the record moved past what the model read. */
	shouldRefresh(lastSeq: Seq): boolean {
		return !this.stopped && lastSeq > this.through;
	}

	/** Signal the turn in flight. The pass ends, and the driver runs no other. */
	abort(): void {
		this.stopped = true;
		this.cut.abort();
		this.turn?.abort();
	}

	/** Stop the socket and the room tools server. The driver calls this once the activation is over. */
	close(): void {
		this.abort();
		this.bridge?.close();
		this.scratch?.remove();
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(input: PassInput): Promise<PassResult> {
		try {
			if (this.stopped) return { failed: false };
			this.view = input.view;
			const prompt = this.promptFor(input);
			if (prompt === undefined) {
				this.advance(input.view.through);
				return { failed: false };
			}
			const thread = await this.start(input.view);
			if (this.stopped) return { failed: false };
			this.reading = input.view.through;
			return this.finish(await this.attempt(thread, prompt));
		} catch (error) {
			return this.finish(this.broke(error));
		}
	}

	/**
	 * Run the prompt on the thread. A resume that Codex cannot honor fails
	 * before `thread.started`. The prompt then runs on a fresh thread.
	 */
	private async attempt(thread: CodexThreadLike, prompt: string): Promise<PassResult> {
		const result = await this.settle(thread, prompt);
		if (!result.failed || this.resuming === undefined || this.heard || this.stopped) return result;
		this.resuming = undefined;
		if (this.memory !== undefined) this.memory.id = undefined;
		const fresh = this.begin(undefined);
		this.thread = fresh;
		return this.settle(fresh, prompt);
	}

	/** One run of the prompt. A fault of the run is a transient failure. */
	private async settle(thread: CodexThreadLike, prompt: string): Promise<PassResult> {
		try {
			return await this.run(thread, prompt);
		} catch (error) {
			return this.broke(error);
		}
	}

	/** The prompt of a pass: the mechanism, the agent and the whole view first, then the delta, or none when nothing is new. */
	private promptFor(input: PassInput): string | undefined {
		if (input.kind === 'delta') return renderDelta(input.view, input.since);
		if (this.thread !== undefined) return renderActivation(input.view, this.definition).context;
		// The thread has no system prompt of its own, so the first prompt carries it.
		const { mechanism, agent, context } = renderActivation(input.view, this.definition);
		return `${HARNESS_NOTE}\n\n${mechanism}\n\n${agent}\n\n${context}`;
	}

	/** Open the socket and the thread on the first pass. Later passes keep them. */
	private async start(view: ActivationView): Promise<CodexThreadLike> {
		if (this.thread !== undefined) return this.thread;
		if (view.spec.seat !== this.definition.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		// The catalog comes first. A model with no entry fails before anything opens.
		const scratch = await this.seal();
		// Keep the scratch before the bridge opens, so a failed bridge still removes it on close.
		this.scratch = scratch;
		const bridge = await startBridge(view, this.definition, this.binding(), () =>
			this.currentView(view),
		);
		this.bridge = bridge;
		if (this.stopped) {
			bridge.close();
			scratch?.remove();
		}
		const make = this.options.client ?? ((options: CodexOptions) => new Codex(options));
		this.client = make(clientOptions(this.options, bridge.socketPath, scratch));
		this.resuming = this.memory === undefined ? undefined : (this.memory.id ?? resumeOf(view));
		this.thread = this.begin(this.resuming);
		return this.thread;
	}

	/** The scratch of a seat with no native tools. A seat with `nativeTools: 'codex'` has none. */
	private async seal(): Promise<Scratch | undefined> {
		const executor = codexOf(this.definition.executor);
		if (executor.nativeTools === 'codex') return undefined;
		const source =
			this.options.catalog ?? installedCatalog(this.options.codexPath, this.options.env);
		return scratchFor(executor.model, source);
	}

	/** Open a thread: the one to resume when `resume` names it, else a fresh one. */
	private begin(resume: string | undefined): CodexThreadLike {
		if (this.client === undefined) throw new Error('The Codex client is not open.');
		const options = threadOptions(codexOf(this.definition.executor), this.scratch);
		this.heard = false;
		return resume === undefined
			? this.client.startThread(options)
			: this.client.resumeThread(resume, options);
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

	/** Run one turn to its end, and report how it ended. */
	private async run(thread: CodexThreadLike, prompt: string): Promise<PassResult> {
		const turn = new AbortController();
		this.turn = turn;
		try {
			return await this.stream(thread, prompt, turn.signal);
		} finally {
			this.turn = undefined;
		}
	}

	/** Read the events of one turn. */
	private async stream(
		thread: CodexThreadLike,
		prompt: string,
		signal: AbortSignal,
	): Promise<PassResult> {
		const { events } = await thread.runStreamed(prompt, { signal });
		const ending = new Ending();
		for await (const event of events) {
			this.handle(event);
			if (ending.over(event)) break;
		}
		if (this.stopped) return { failed: false };
		return passResultOf(ending.failure());
	}

	/** One thread event: its steps, its changed paths, and the position the turn read. */
	private handle(event: ThreadEvent): void {
		if (event.type === 'thread.started') {
			this.heard = true;
			if (this.memory !== undefined) this.memory.id = event.thread_id;
		}
		if (event.type === 'turn.started') this.advance(this.reading);
		this.bridge?.note(changedPaths(event));
		for (const step of this.steps.steps(event)) {
			this.trace.record(step);
			if (step.type === 'tool_call') this.started(step.call, step.name);
			if (step.type === 'tool_result') this.finished(step.call);
		}
	}

	private started(call: string, name: string): void {
		this.named.set(call, name);
		// A room tool is the room's own event, not a tool's.
		if (!isRoomTool(name)) this.toolEvent('tool_execution_start', name);
	}

	private finished(call: string): void {
		const name = this.named.get(call);
		this.named.delete(call);
		if (name !== undefined && !isRoomTool(name)) this.toolEvent('tool_execution_end', name);
	}

	private toolEvent(type: 'tool_execution_start' | 'tool_execution_end', toolName: string): void {
		this.emit({ type, agent: this.definition.name, activation: this.id, toolName });
	}

	/** A failure reaches the host as an `error` event before the driver sees the result. */
	private finish(result: PassResult): PassResult {
		if (result.failed && result.message !== undefined) {
			this.emit({
				type: 'error',
				agent: this.definition.name,
				activation: this.id,
				error: new Error(result.message),
				...(result.cause === undefined ? {} : { cause: result.cause }),
			});
		}
		return result;
	}

	/**
	 * The result for a fault of this executor, such as a lost process or a
	 * build error. It is transient, so the room tries the activation again.
	 * A model with no catalog entry is permanent.
	 */
	private broke(error: unknown): PassResult {
		if (this.stopped) return { failed: false };
		const message = error instanceof Error ? error.message : String(error);
		const cause = error instanceof PermanentError ? 'permanent' : 'transient';
		return { failed: true, cause, message };
	}
}
