/**
 * The Codex executor: one activation's session, from the pass the driver
 * hands it until the activation stops.
 *
 * The Codex SDK owns the loop. One activation holds one Codex thread. A
 * pass runs one turn of it: the first pass sends the whole view, and a
 * later pass sends the delta. A turn ends on `turn.completed` or
 * `turn.failed`.
 *
 * - **Seat text.** The SDK has no system prompt option. The harness note,
 *   the mechanism and the agent part go in the config of the client, fixed
 *   for the activation (`options.ts`). The first prompt holds the view
 *   alone. A `codex` seat that resumes a thread is the exception: Codex
 *   keeps the stored developer message, so that prompt carries the text.
 * - **Home.** Every seat runs in the Codex home of its execution, with the
 *   login of the host linked in (`home.ts`). The config and the
 *   instructions of the host user never reach a seat.
 * - **Room tools.** The core binds the tools. They live in a stdio MCP
 *   server that Codex spawns. The server reaches them through a local
 *   socket that the activation opens (`bridge.ts`).
 * - **Freshness.** The core keeps `readThrough`. Codex sends no echo. The
 *   model reads the prompt when a turn starts, so the activation tells the
 *   core that the model read the range of the prompt on `turn.started`. A
 *   tool result reaches the model when the tool returns, so the activation
 *   tells the core at once: a `missed` answer carries the missed lines.
 * - **Exchange continuity.** Codex keeps its threads on the local disk, and
 *   the release records the id that `thread.started` reports. The
 *   activation resumes the thread that `spec.resume` names, which the room
 *   hands back inside one exchange. A resume that Codex cannot honor fails
 *   before `thread.started`, and the activation starts a fresh thread.
 * - **Steer.** The session has no `steer`. Codex takes no message into a
 *   turn that runs. The driver holds the line, and the next pass reads it.
 * - **Cut.** The signal of the activation signals the turn. `close` stops
 *   the socket and the room tools server.
 */
import type {
	AgentDefinition,
	Executor,
	ExecutorActivation,
	ExecutorSession,
	Pass,
	PassResult,
	ReadRange,
	RoomToolOptions,
} from '@ambionframework/ambion/hosting';
import { failedPass } from '@ambionframework/ambion/hosting';
import {
	Codex,
	type CodexOptions,
	type ThreadEvent,
	type ThreadOptions,
	type TurnOptions,
} from '@openai/codex-sdk';
import { type Bridge, startBridge } from './bridge.ts';
import { type CatalogSource, installedCatalog, type Scratch, scratchFor } from './catalog.ts';
import { CodexSteps, changedPaths } from './codex-trace.ts';
import { passResultOf } from './failure.ts';
import { openHome, type SeatHome, seatHome } from './home.ts';
import {
	type CodexExecutionOptions,
	clientOptions,
	codexOf,
	seatText,
	threadOptions,
} from './options.ts';
import { citing, servedTools } from './tools.ts';

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

/** What builds a Codex executor for one seat: its definition, and the options that run it. */
export interface CodexExecutorOptions extends CodexExecutionOptions {
	readonly definition: AgentDefinition;
	/** Builds the client. Absent, the SDK's own `Codex`. */
	readonly client?: (options: CodexOptions) => CodexClientLike;
	/** Answers the catalog entry of a model. Absent, `codex debug models` on the installed binary. */
	readonly catalog?: CatalogSource;
}

/** The Codex executor. One instance per seat, for as long as the room runs. */
export function createCodexExecutor(options: CodexExecutorOptions): Executor {
	return (activation: ExecutorActivation): ExecutorSession => new Activation(activation, options);
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
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly options: CodexExecutorOptions;
	/** The thread Codex reported last. */
	private reported: string | undefined;
	/** The thread this activation asked Codex to resume. Cleared when the resume fails. */
	private resuming: string | undefined;
	/** Whether Codex reported `thread.started` for the thread in use. */
	private heard = false;
	private client: CodexClientLike | undefined;
	private readonly steps: CodexSteps;
	/** Aborts the turn in flight. A turn that ended holds none, so a late cut never signals a dead process. */
	private turn: AbortController | undefined;
	/** The range of the record the turn in flight reads. The core counts it read when the turn starts. */
	private reading: ReadRange | undefined;
	/** The workspace paths the agent changed since its last say. The next ordinary say cites them. */
	private readonly changed = new Set<string>();
	/** Whether the activation responds. A closing say cites no changed path. */
	private ordinary = true;
	/** What a say and a schedule add: the changed paths, as refs. */
	readonly roomTools: RoomToolOptions = citing(this.changed, () => this.ordinary);
	private bridge: Bridge | undefined;
	/** The patched catalog and the empty directory. Absent when nativeTools is 'codex'. */
	private scratch: Scratch | undefined;
	private thread: CodexThreadLike | undefined;
	/** The Codex home of the seat and the environment of the binary. Absent until the first pass. */
	private home: SeatHome | undefined;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: CodexExecutorOptions) {
		this.activation = activation;
		this.steps = new CodexSteps(activation.id);
		this.definition = options.definition;
		this.options = options;
		activation.signal.addEventListener('abort', () => this.abort(), { once: true });
	}

	/** The id of the Codex thread to record with the release. Absent until Codex reports one. */
	get session(): string | undefined {
		return this.reported;
	}

	/** The activation was cut: signal the turn in flight. The pass ends. */
	private abort(): void {
		this.stopped = true;
		this.turn?.abort();
	}

	/** Stop the socket and the room tools server. The driver calls this once the activation is over. */
	close(): void {
		this.abort();
		this.bridge?.close();
		this.scratch?.remove();
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(pass: Pass): Promise<PassResult> {
		try {
			this.ordinary = pass.view.spec.purpose.kind !== 'summarize';
			const prompt = await pass.record();
			if (prompt === undefined) return { failed: false };
			const text = this.promptText(pass, prompt.text);
			const thread = await this.start(pass);
			if (this.stopped) return { failed: false };
			this.reading = prompt.range;
			return await this.attempt(thread, text);
		} catch (error) {
			return this.broke(error);
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
		this.reported = undefined;
		const fresh = this.begin(undefined);
		this.thread = fresh;
		return this.settle(fresh, prompt);
	}

	/** One run of the prompt. A fault of the run is a failed pass. */
	private async settle(thread: CodexThreadLike, prompt: string): Promise<PassResult> {
		try {
			return await this.run(thread, prompt);
		} catch (error) {
			return this.broke(error);
		}
	}

	/**
	 * The text to run. Codex keeps the developer message stored with a resumed
	 * thread, so the config cannot replace it. The first prompt of a `codex`
	 * seat that resumes carries the seat text. If the resume fails, the fresh
	 * thread runs the same prompt and holds the text twice.
	 */
	private promptText(pass: Pass, view: string): string {
		const resumes = this.thread === undefined && pass.resumeId !== undefined;
		if (!resumes || codexOf(this.definition.executor).nativeTools !== 'codex') return view;
		return `${seatText(pass)}\n\n${view}`;
	}

	/** Open the socket and the thread on the first pass. Later passes keep them. */
	private async start(pass: Pass): Promise<CodexThreadLike> {
		if (this.thread !== undefined) return this.thread;
		// The home comes first. The catalog run and every thread read the config and the login there.
		const home = seatHome(this.options);
		await openHome(home);
		this.home = home;
		// The seat text is fixed for the activation. The client config carries it.
		const seat = seatText(pass);
		// The catalog comes next. A model with no entry fails before anything opens.
		const scratch = await this.seal(seat);
		// Keep the scratch before the bridge opens, so a failed bridge still removes it on close.
		this.scratch = scratch;
		const tools = servedTools(pass.tools, this.activation);
		const bridge = await startBridge(tools, this.activation.signal);
		this.bridge = bridge;
		if (this.stopped) {
			bridge.close();
			scratch?.remove();
		}
		const make = this.options.client ?? ((options: CodexOptions) => new Codex(options));
		this.client = make(clientOptions(this.options, home, bridge.socketPath, seat, scratch));
		this.resuming = pass.resumeId;
		this.thread = this.begin(this.resuming);
		return this.thread;
	}

	/** The scratch of a seat with no native tools, with the seat text in it. A seat with `nativeTools: 'codex'` has none. */
	private async seal(seat: string): Promise<Scratch | undefined> {
		const executor = codexOf(this.definition.executor);
		if (executor.nativeTools === 'codex') return undefined;
		const home = this.home;
		if (home === undefined) throw new Error('The Codex home is not open.');
		const source = this.options.catalog ?? installedCatalog(this.options.codexPath, home.env);
		return scratchFor(executor.model, source, seat);
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

	/** One thread event: its steps, its changed paths, and the range the turn read. */
	private handle(event: ThreadEvent): void {
		if (event.type === 'thread.started') {
			this.heard = true;
			this.reported = event.thread_id;
		}
		if (event.type === 'turn.started' && this.reading !== undefined) {
			this.activation.read(this.reading);
		}
		for (const path of changedPaths(event)) this.changed.add(path);
		for (const step of this.steps.steps(event)) this.activation.trace.record(step);
	}

	/**
	 * The result for a fault of this executor, such as a lost process or a
	 * build error. A cut closes the run, and the fault it throws is no failure.
	 */
	private broke(error: unknown): PassResult {
		return this.stopped ? { failed: false } : failedPass(error);
	}
}
