/**
 * The Codex opener: it opens one running activation, which takes each pass
 * the driver hands it until the activation stops.
 *
 * `codex app-server` owns the loop. One activation holds one process and one
 * Codex thread. A pass is one Codex turn, the object that `turn/start`
 * creates. The first pass sends the whole view, and a later pass sends the
 * delta. A pass ends on `turn/completed`.
 *
 * - **Seat text.** `baseInstructions` of `thread/start` and `thread/resume`
 *   carries the harness note, the mechanism, and the agent part. A resume
 *   with new text replaces the old text. Every prompt holds the record
 *   alone.
 * - **No native tools.** A seat has no native tool. The catalog entry, the
 *   config, and the thread policy turn each one off (`catalog.ts`). Files and
 *   a shell come only from the tools of the agent.
 * - **Home.** Every seat runs in the Codex home of its execution, with the
 *   login of the host linked in (`home.ts`). The config and the
 *   instructions of the host user never reach a seat.
 * - **Room tools.** The core binds the tools, and the thread lists them as
 *   dynamic tools. Codex sends each call as the server request
 *   `item/tool/call`, and the activation answers it in the process of the
 *   host. The seat approves nothing: every other server request gets an
 *   error.
 * - **Freshness.** The core keeps `readThrough`. Each input carries a
 *   `clientUserMessageId`, and Codex echoes the input as a `userMessage`
 *   item with that id. The activation tells the core that the model read the
 *   range of the input on its echo, and on nothing earlier. A tool result
 *   reaches the model when the tool returns, so the activation tells the core
 *   at once: a `missed` answer carries the missed lines.
 * - **Steer.** A line that lands during a pass goes to `turn/steer` with the
 *   `turnId` of the pass. The pass keeps running, and the echo of the line tells
 *   the core that the model read it. A line that arrives before `turn/start`
 *   answers waits, and the pass sends it right after. A pass that is over
 *   refuses the line, and the line waits for the next delta.
 * - **Exchange continuity.** Codex keeps its threads on the local disk, and
 *   the release records the thread id. The activation resumes the thread that
 *   `spec.resume` names, which the room hands back inside one exchange. A
 *   thread that keeps other tools than this activation binds, or that Codex
 *   cannot resume, gives way to a fresh thread.
 * - **Session.** The activation records one `session` step and one `notice`
 *   for each thread it opens. The notice holds the thread id, the home, and
 *   the rollout file, so the trace joins to the full record.
 * - **Cut.** The signal of the activation sends `turn/interrupt`. The pass
 *   ends when Codex reports the pass interrupted. `close` ends the input of
 *   the process.
 */
import type {
	ActivationOpener,
	AgentDefinition,
	ExecutorActivation,
	Pass,
	PassRecord,
	PassResult,
	RunningActivation,
	Seq,
} from '@ambionframework/ambion/hosting';
import { failedPass } from '@ambionframework/ambion/hosting';
import {
	type Connect,
	type Connection,
	type Exit,
	RpcError,
	spawnAppServer,
} from './app-server.ts';
import {
	type CatalogSource,
	codexBinary,
	installedCatalog,
	type Scratch,
	scratchFor,
} from './catalog.ts';
import { CodexSteps, sessionStep } from './codex-trace.ts';
import { turnFailure } from './failure.ts';
import { openHome, type SeatHome, seatHome } from './home.ts';
import { LoginRefused, type LoginResult, LoginWait, loginError } from './login.ts';
import {
	apiKeyOf,
	type CodexExecutionOptions,
	codexOf,
	launchOf,
	seatText,
	threadParams,
} from './options.ts';
import {
	type DynamicToolCallParams,
	type DynamicToolCallResponse,
	knownItem,
	type Notification,
	notificationOf,
	REFUSED,
	type ThreadOpened,
	type Turn,
	textInput,
} from './protocol.ts';
import { Echoes, keptTools, sameTools } from './thread.ts';
import { type CodexTool, servedTools } from './tools.ts';

/** How long a cut waits for `turn/completed` before the pass ends, in milliseconds. */
const CUT_GRACE_MS = 5_000;

/** The client the process hears of in `initialize`. */
const CLIENT = { name: 'ambion', title: null, version: '0.0.0' };

/** What builds a Codex opener for one seat: its definition, and the options that run it. */
export interface CodexOpenerOptions extends CodexExecutionOptions {
	readonly definition: AgentDefinition;
	/** Opens the connection to the app-server. Absent, the real `codex app-server`. */
	readonly connect?: Connect;
	/** Answers the catalog entry of a model. Absent, `codex debug models` on the installed binary. */
	readonly catalog?: CatalogSource;
}

/** The Codex opener. One instance per seat, for as long as the room runs. */
export function createCodexOpener(options: CodexOpenerOptions): ActivationOpener {
	return (activation: ExecutorActivation): RunningActivation => new Activation(activation, options);
}

/** A steered line held until the pass sends its prompt. */
interface Held {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

/** The pass in flight. `id` is the `turnId`, and it is set when `turn/start` answers. */
interface Running {
	id?: string;
	/** Whether Codex reported the pass complete. A steer after that finds no pass. */
	over: boolean;
	readonly settle: (result: PassResult) => void;
	timer?: ReturnType<typeof setTimeout>;
}

/** The text of a failure with the end of the standard error after it. */
function withTail(message: string, tail: string): string {
	return tail === ''
		? message
		: `${message}\n\nThe standard error of the process ended with:\n${tail}`;
}

/** One activation, from the moment the room wakes a seat until it stops. */
class Activation implements RunningActivation {
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly options: CodexOpenerOptions;
	private readonly steps: CodexSteps;
	private readonly echoes = new Echoes();
	/** The steers held until the pass sends its prompt. */
	private held: Held[] = [];
	private connection: Connection | undefined;
	/** Waits for `account/login/completed` while a login runs. */
	private loggedIn: ((result: LoginResult) => void) | undefined;
	/** How the process ended, when it did. */
	private ended: Exit | undefined;
	/** The patched catalog and the empty directory. Absent until the first pass. */
	private scratch: Scratch | undefined;
	/** The Codex home of the seat and the environment of the binary. Absent until the first pass. */
	private home: SeatHome | undefined;
	private tools: readonly CodexTool[] = [];
	/** The thread in use. Absent until the first pass opens one. */
	private thread: ThreadOpened | undefined;
	private running: Running | undefined;
	private stopped = false;

	constructor(activation: ExecutorActivation, options: CodexOpenerOptions) {
		this.activation = activation;
		this.steps = new CodexSteps(activation.id);
		this.definition = options.definition;
		this.options = options;
		activation.signal.addEventListener('abort', () => this.abort(), { once: true });
	}

	/** The id of the Codex thread to record with the release. Absent until a thread opens. */
	get session(): string | undefined {
		return this.thread?.thread.id;
	}

	/**
	 * A line landed while a pass runs. Until `turn/start` answers, the line
	 * waits: the pass sends it right after. Then the line goes to the pass,
	 * and its echo confirms it. A line still held when the pass settles waits
	 * for the next delta.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		const turn = this.running;
		if (turn === undefined || turn.id === undefined) this.held.push({ after, seq, line });
		else if (!turn.over) this.send(turn.id, line, { after, through: seq });
	}

	/** The activation was cut: interrupt the pass. The pass ends when Codex reports it. */
	private abort(): void {
		this.stopped = true;
		const turn = this.running;
		if (turn === undefined) return;
		this.interrupt(turn);
		// A server that never answers must not hold the pass.
		turn.timer = setTimeout(() => turn.settle({ failed: false }), CUT_GRACE_MS);
		turn.timer.unref();
	}

	/** Ask Codex to stop the pass, once the pass has a `turnId`. */
	private interrupt(turn: Running): void {
		if (turn.id === undefined || this.thread === undefined) return;
		this.rpc('turn/interrupt', { threadId: this.thread.thread.id, turnId: turn.id }).catch(
			() => {},
		);
	}

	/** End the input and the process. The driver calls this once the activation is over. */
	close(): void {
		this.stopped = true;
		this.running?.settle({ failed: false });
		this.connection?.close();
		this.scratch?.remove();
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(pass: Pass): Promise<PassResult> {
		try {
			const prompt = await pass.record();
			if (prompt === undefined) return { failed: false };
			await this.open(pass);
			if (this.stopped) return { failed: false };
			return await this.turn(prompt);
		} catch (error) {
			return this.broke(error);
		} finally {
			// A line the pass never took waits for the next delta.
			this.held = [];
		}
	}

	/** Send a request to the process. */
	private async rpc<T>(method: string, params: unknown): Promise<T> {
		if (this.connection === undefined) throw new Error('The Codex process is not open.');
		return (await this.connection.request(method, params)) as T;
	}

	/** Start the process and open the thread on the first pass. Later passes keep both. */
	private async open(pass: Pass): Promise<void> {
		if (this.ended !== undefined) throw new Error(this.exitText(this.ended));
		if (this.thread !== undefined) return;
		const executor = codexOf(this.definition.executor);
		// The home comes first. The catalog run and the process read the config and the login there.
		const home = seatHome(this.options);
		await openHome(home);
		this.home = home;
		// The catalog comes next. A model with no entry fails before anything opens.
		const source = this.options.catalog ?? installedCatalog(this.options.codexPath, home.env);
		const scratch = await scratchFor(executor.model, source);
		// Keep the scratch before the process starts, so a failed start still removes it on close.
		this.scratch = scratch;
		if (this.stopped) return;
		this.tools = servedTools(pass.tools, this.activation);
		const binary = codexBinary(this.options.codexPath);
		const connect = this.options.connect ?? spawnAppServer;
		this.connection = connect(launchOf(binary, home, executor, scratch), {
			notification: (method, params) => this.notified(method, params),
			request: (method, params) => this.requested(method, params),
			exit: (exit) => this.exited(exit),
		});
		await this.rpc('initialize', {
			clientInfo: CLIENT,
			capabilities: { experimentalApi: true, requestAttestation: false },
		});
		this.connection.notify('initialized');
		await this.login(home);
		await this.openThread(pass, seatText(pass));
	}

	/**
	 * Log in with `CODEX_API_KEY`, when the seat environment holds one. The
	 * app-server does not read the variable itself. A failure names the cause
	 * and never the key.
	 */
	private async login(home: SeatHome): Promise<void> {
		const apiKey = apiKeyOf(home);
		if (apiKey === undefined) return;
		const wait = new LoginWait();
		this.loggedIn = (result) => wait.completed(result);
		try {
			const started = await this.rpc<{ loginId?: string | null } | undefined>(
				'account/login/start',
				{ type: 'apiKey', apiKey },
			);
			const result = await wait.result(started?.loginId ?? null);
			if (!result.success) throw new LoginRefused(result.error ?? 'Codex gave no reason');
		} catch (error) {
			if (this.ended !== undefined) throw error;
			throw loginError(error, apiKey);
		} finally {
			wait.stop();
			this.loggedIn = undefined;
		}
	}

	/** Open the thread: the one to resume when the pass names it and it fits, else a fresh one. */
	private async openThread(pass: Pass, seat: string): Promise<void> {
		const executor = codexOf(this.definition.executor);
		if (this.scratch === undefined) throw new Error('The Codex scratch is not open.');
		const params = threadParams(executor, this.scratch, seat);
		const resumed =
			pass.resumeId === undefined ? undefined : await this.resumed(pass.resumeId, params);
		const opened =
			resumed ??
			(await this.rpc<ThreadOpened>('thread/start', {
				...params,
				dynamicTools: this.tools.map((tool) => tool.spec),
			}));
		this.thread = opened;
		await this.announce(opened);
	}

	/**
	 * Resume a thread, and give it up when it cannot serve this activation: a
	 * refusal of Codex, or other tools than this activation binds. The pass
	 * then starts a fresh thread.
	 */
	private async resumed(
		id: string,
		params: ReturnType<typeof threadParams>,
	): Promise<ThreadOpened | undefined> {
		try {
			const opened = await this.rpc<ThreadOpened>('thread/resume', {
				threadId: id,
				...params,
				excludeTurns: true,
			});
			const kept = opened.thread.path === null ? undefined : await keptTools(opened.thread.path);
			if (
				kept !== undefined &&
				sameTools(
					kept,
					this.tools.map((tool) => tool.spec),
				)
			)
				return opened;
			this.skipped(id, 'the thread keeps other tools');
		} catch (error) {
			// A process that died is no refusal.
			if (!(error instanceof RpcError)) throw error;
			this.skipped(id, error.message);
		}
		return undefined;
	}

	/** Say in the trace that a thread to resume gave way to a fresh one. */
	private skipped(thread: string, reason: string): void {
		this.activation.trace.record({
			type: 'notice',
			level: 'info',
			text: 'Codex thread not resumed',
			data: { thread, reason },
		});
	}

	/** Record the session step and the notice of a thread that just opened. */
	private async announce(opened: ThreadOpened): Promise<void> {
		const [auth, servers] = await Promise.all([this.auth(), this.servers(opened.thread.id)]);
		this.activation.trace.record(
			sessionStep(opened, { auth, tools: this.tools.map((tool) => tool.spec.name), servers }),
		);
		this.activation.trace.record({
			type: 'notice',
			level: 'info',
			text: 'Codex thread',
			data: {
				thread: opened.thread.id,
				home: this.home?.path,
				...(opened.thread.path === null ? {} : { rollout: opened.thread.path }),
			},
		});
	}

	/** The type of the account of the seat. The step names the source of a credential, never the credential. */
	private async auth(): Promise<string | undefined> {
		try {
			const { account } = await this.rpc<{ account: { type: string } | null }>('account/read', {});
			return account?.type ?? 'none';
		} catch {
			return undefined;
		}
	}

	/** The MCP servers of the thread and their status. A seat has none but the disabled ones. */
	private async servers(thread: string): Promise<{ name: string; status: string }[]> {
		try {
			const { data } = await this.rpc<{
				data: { name: string; runtimeStatus: string | null }[];
			}>('mcpServerStatus/list', { threadId: thread, detail: 'toolsAndAuthOnly' });
			return data.map(({ name, runtimeStatus }) => ({ name, status: runtimeStatus ?? 'unknown' }));
		} catch {
			return [];
		}
	}

	/** Run one pass to its end, and report how it ended. */
	private async turn(prompt: PassRecord): Promise<PassResult> {
		if (this.thread === undefined) throw new Error('The Codex thread is not open.');
		const thread = this.thread.thread.id;
		const done = Promise.withResolvers<PassResult>();
		const turn: Running = { over: false, settle: done.resolve };
		this.running = turn;
		try {
			const id = crypto.randomUUID();
			this.echoes.expect(id, prompt.range);
			const started = await this.rpc<{ turn: Turn }>('turn/start', {
				threadId: thread,
				clientUserMessageId: id,
				input: textInput(prompt.text),
			});
			turn.id = started.turn.id;
			if (this.stopped) this.interrupt(turn);
			for (const held of this.held.splice(0)) {
				this.send(started.turn.id, held.line, { after: held.after, through: held.seq });
			}
			return await done.promise;
		} finally {
			clearTimeout(turn.timer);
			this.running = undefined;
		}
	}

	/** Send one steered line to the pass. Its echo tells the core that the model read the range. */
	private send(turn: string, line: string, range: { after: Seq; through: Seq }): void {
		if (this.thread === undefined) return;
		const id = crypto.randomUUID();
		this.echoes.expect(id, range);
		this.rpc('turn/steer', {
			threadId: this.thread.thread.id,
			expectedTurnId: turn,
			clientUserMessageId: id,
			input: textInput(line),
		}).catch(() => this.echoes.forget(id));
	}

	/** One notification of the server: its steps, its echo, and, for a completed pass, the end of the pass. */
	private notified(method: string, params: unknown): void {
		if (method === 'account/login/completed') {
			this.loggedIn?.(params as LoginResult);
			return;
		}
		const note = notificationOf(method, params);
		if (note === undefined || this.other(note) || this.staleUsage(note)) return;
		for (const step of this.steps.steps(note)) this.activation.trace.record(step);
		const item = note.method === 'item/completed' ? knownItem(note.params.item) : undefined;
		if (item?.type === 'userMessage') this.echoed(item.clientId);
		if (note.method === 'turn/completed') this.completed(note.params.turn);
	}

	/** Whether a notification belongs to a thread other than the one in use. */
	private other(note: Notification): boolean {
		const thread = 'threadId' in note.params ? note.params.threadId : null;
		return this.thread !== undefined && thread !== null && thread !== this.thread.thread.id;
	}

	/**
	 * Whether a usage note belongs to no running pass. Codex repeats the usage
	 * of the last pass after a resume, and the earlier activation counted it.
	 */
	private staleUsage(note: Notification): boolean {
		return (
			note.method === 'thread/tokenUsage/updated' &&
			(this.running === undefined || note.params.turnId !== this.running.id)
		);
	}

	/** Codex echoed an input: the model has it, so the core counts its range read. */
	private echoed(id: string | null): void {
		const range = this.echoes.confirm(id);
		if (range !== undefined) this.activation.read(range);
	}

	/** The pass ended. The pass settles with how it ended. */
	private completed(turn: Turn): void {
		const running = this.running;
		if (running === undefined) return;
		running.over = true;
		if (this.stopped || turn.status === 'interrupted') running.settle({ failed: false });
		else if (turn.status === 'failed') running.settle(turnFailure(turn.error));
		else running.settle({ failed: false });
	}

	/** A request of the server. The seat runs its own tools and approves nothing. */
	private async requested(method: string, params: unknown): Promise<unknown> {
		if (method === 'item/tool/call') return this.called(params as DynamicToolCallParams);
		this.activation.trace.record({
			type: 'notice',
			level: 'warning',
			text: `Codex sent the request ${method}. A seat answers a tool call and refuses every other request.`,
		});
		throw new RpcError(REFUSED, `A Codex seat does not answer ${method}.`);
	}

	/** Run one tool call of the model on the tool the core bound. */
	private async called(call: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
		const tool = this.tools.find((candidate) => candidate.spec.name === call.tool);
		const failed = (text: string): DynamicToolCallResponse => ({
			contentItems: [{ type: 'inputText', text }],
			success: false,
		});
		if (tool === undefined || call.namespace !== null)
			return failed(`No tool named '${call.tool}'.`);
		if (this.activation.signal.aborted) return failed('The activation was cut.');
		return tool.run(call.arguments, this.steps.idOf(call.turnId, call.callId));
	}

	/** The process ended. A pass in flight fails, and a cut or a closed activation reports no failure. */
	private exited(exit: Exit): void {
		this.ended = exit;
		const turn = this.running;
		if (turn === undefined) return;
		turn.settle(this.stopped ? { failed: false } : this.exitFailure(exit));
	}

	private exitText(exit: Exit): string {
		return withTail(`The Codex app-server ${exit.reason} before the pass ended.`, exit.stderr);
	}

	private exitFailure(exit: Exit): PassResult {
		return { failed: true, cause: 'transient', message: this.exitText(exit) };
	}

	/**
	 * The result for a fault of this executor, such as a lost process or a
	 * build error. A cut closes the run, and the fault it throws is no failure.
	 * A process that ended names its cause and its standard error.
	 */
	private broke(error: unknown): PassResult {
		if (this.stopped) return { failed: false };
		return this.ended === undefined ? failedPass(error) : this.exitFailure(this.ended);
	}
}
