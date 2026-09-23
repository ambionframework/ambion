/**
 * The Pi executor: one activation's session, from the pass the driver hands
 * it until the activation stops.
 *
 * A seat is seated for as long as the room runs. An activation lasts seconds,
 * and it owns what belongs to one:
 *
 * - **Its id.** Derived from the record: the message that woke the seat and
 *   the seat's name, or the close it answers and the attempt. Every call it
 *   makes carries it.
 * - **What it acknowledged.** `readThrough` is the highest contiguous
 *   position in provider input. A provider request or an accepted ordinary
 *   say advances it. Freshness refuses a draft against a newer record.
 * - **What arrived while it worked.** A message that lands mid-activation is steered
 *   in. It reaches the provider after the request it lands during. PiContext
 *   records the structured range only when that later request receives it.
 *
 * The driver hands a session a first pass over the whole view. The session
 * renders the prompt, resolves the model, binds the tools, and builds one Pi
 * agent. The session keeps that agent for every later pass of the activation.
 * A later pass prompts it with the delta: what the record holds beyond
 * `readThrough`. The transcript of the activation stays whole.
 *
 * **Three spans, and only two are ours.** Pi has a *turn* — one request to a
 * provider and the tools it calls — and a *run*, which is one `prompt()` and
 * the turns inside it. An activation is wider than both: it is one or more
 * runs, because a message landing mid-activation starts another run over the
 * record as it now stands. The word for what a room does to a seat is
 * `activation` ([`agent.md`](../../../docs/agent.md), Execution boundary), and the
 * lease entries and the trace of each one carry that word.
 *
 * **Exchange continuity.** The executor keeps the transcript of the last
 * activation that did not fail, under the id of the activation that began
 * it. The next activation continues that transcript only when the room hands
 * back the same id in `spec.resume`, which it does inside one exchange. It
 * then builds its agent over the transcript and prompts with what the record
 * holds beyond the position the transcript read through. Any other activation
 * drops the transcript and begins a fresh one. The kept transcript lives in
 * this process, so a restart begins a fresh one. Freshness still governs
 * speech: `readThrough` starts at the position the kept transcript read, and
 * a say against newer record is refused.
 */
import type {
	ActivationView,
	AgentDefinition,
	AgentExecutor,
	ExecutionEvent,
	Executor,
	ExecutorActivation,
	ExecutorSession,
	FailureCause,
	HarnessSession,
	PassInput,
	PassResult,
	RoomProtocol,
	Seq,
	TraceSink,
} from '@ambionframework/ambion/hosting';
import {
	classifyCause,
	renderActivation,
	renderDelta,
	sessionToResume,
} from '@ambionframework/ambion/hosting';
import type {
	AgentEvent,
	AgentMessage,
	Agent as PiAgent,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import { PiContext } from './context.ts';
import { PiSteps } from './pi-trace.ts';
import type { ModelResolver } from './services.ts';
import { binding, toolsFor } from './tools.ts';

/** What builds a Pi executor for one seat: its definition, and the room's model services. */
export interface PiExecutorOptions {
	readonly definition: AgentDefinition;
	readonly model: ModelResolver;
	readonly stream: StreamFn;
	/** The room's clock. Pi stamps every message it is handed with it. */
	readonly now: () => number;
}

/** What a seat keeps between the activations of one exchange. */
interface SeatMemory {
	/** The id of the activation that began the transcript. The release records it. */
	id: string;
	/** The transcript of the last activation that did not fail. */
	messages: AgentMessage[];
	/** The position the transcript read through. */
	through: Seq;
}

/** The holder of a seat's memory. It holds nothing before the first activation that does not fail. */
interface MemoryHolder {
	kept?: SeatMemory;
}

/** The Pi executor. One instance per seat, for as long as the room runs. */
export function createPiExecutor(options: PiExecutorOptions): Executor {
	const memory: MemoryHolder = {};
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options, memory);
		},
	};
}

/** One activation, from the moment the room wakes a seat until it stops. */
export class Activation implements ExecutorSession {
	readonly id: string;
	private readonly room: RoomProtocol;
	private readonly emit: (event: ExecutionEvent) => void;
	private readonly definition: AgentDefinition;
	private readonly model: ModelResolver;
	private readonly stream: StreamFn;
	private readonly now: () => number;
	/** The seat's memory across the activations of one exchange. */
	private readonly memory: MemoryHolder;
	/** The id of the transcript this activation continues or begins. Set on the first pass. */
	private transcript: string | undefined;
	/** The sink for the steps this executor owns. The driver closes it. */
	private readonly trace: TraceSink;
	private readonly steps = new PiSteps();
	/** How much record context the provider consumed. */
	private readonly context = new PiContext();
	/** The steers held before Pi first polls its queue. */
	private held: { after: Seq; seq: Seq; line: string }[] = [];
	private providerStarted = false;
	/** The Pi agent of this activation. Built on the first pass, kept for the rest. */
	private agent: PiAgent | undefined;
	/** The view of the running pass. The tools read the room and exchange from it. */
	private view: ActivationView | undefined;
	private stopped = false;

	constructor(
		activation: ExecutorActivation,
		options: PiExecutorOptions,
		memory: MemoryHolder = {},
	) {
		this.id = activation.id;
		this.room = activation.room;
		this.emit = activation.emit;
		this.trace = activation.trace;
		this.definition = options.definition;
		this.model = options.model;
		this.stream = options.stream;
		this.now = options.now;
		this.memory = memory;
	}

	/**
	 * The transcript to record with the release: the one this activation
	 * continued or began, when the seat keeps it. Absent when the activation
	 * ran no pass, or a fresh transcript failed before the seat kept it.
	 */
	get session(): HarnessSession | undefined {
		const kept = this.memory.kept;
		if (kept === undefined || kept.id !== this.transcript) return undefined;
		return { harness: 'pi', id: kept.id };
	}

	/** The seq this activation may commit against: the freshness boundary `readThrough`. */
	get readThrough(): Seq {
		return this.context.readThrough;
	}

	/** Whether `abort` was called. The driver checks this before another room round trip. */
	get cancelled(): boolean {
		return this.stopped;
	}

	/** An accepted ordinary say confirms this activation consumed the record through here. */
	acknowledgeThrough(seq: Seq): void {
		this.context.acknowledgeThrough(seq);
	}

	/** A rejected commit placed this context in Pi's next tool-result input. */
	toolResultExpected(toolCallId: string, seq: Seq): void {
		this.context.toolResultExpected(toolCallId, seq);
	}

	/**
	 * A message landed while this activation was working. It reaches the model as a
	 * steer. PiContext records its range without parsing rendered text.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		const context = { after, seq, line };
		if (this.providerStarted && this.agent !== undefined) {
			this.context.steer(this.agent, context, this.now());
			this.trace.record({ type: 'steer', seq, consumed: true });
		} else {
			this.held.push(context);
		}
	}

	/** Pi's abort ends the run but not its queues; the driver stops running passes too. */
	abort(): void {
		this.stopped = true;
		this.agent?.abort();
	}

	/**
	 * Whether the record moved past acknowledged context. A queued steer or a
	 * newer room position requires a fresh pass. A dropped steer stays on the
	 * record and is delivered again by that later pass's delta. A cancelled
	 * session always answers no, though the driver checks `cancelled` itself
	 * first, before it ever renews on this session's behalf.
	 */
	shouldRefresh(lastSeq: Seq): boolean {
		if (this.stopped) return false;
		const agent = this.agent;
		if (!(agent?.hasQueuedMessages() ?? false) && lastSeq <= this.readThrough) return false;
		agent?.clearAllQueues();
		return true;
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(input: PassInput): Promise<PassResult> {
		try {
			if (this.stopped) return { failed: false };
			// The fresh view becomes acknowledged only when Pi sends it to a provider.
			// A steer held past its pass never reached the model as a steer.
			for (const dropped of this.held.splice(0)) {
				this.trace.record({ type: 'steer', seq: dropped.seq, consumed: false });
			}
			this.providerStarted = false;
			this.view = input.view;
			this.adopt(input.view);
			const agent = await this.agentFor(input.view);
			if (this.stopped) return { failed: false };
			const prompt = this.promptFor(input);
			if (prompt === undefined) return this.nothingNew(input.view);
			await agent.prompt(prompt);
			const failure = this.executionFailure(agent);
			if (failure === undefined) this.keep(agent);
			if (failure !== undefined) {
				return { failed: true, cause: failure.cause, message: failure.error.message };
			}
			return endedForLength(agent) ? { failed: false, stop: 'length' } : { failed: false };
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * On the first pass, continue the kept transcript when the room names it
	 * in `spec.resume`. Otherwise drop it: this activation begins a fresh one.
	 */
	private adopt(view: ActivationView): void {
		if (this.transcript !== undefined) return;
		const kept = this.memory.kept;
		if (kept !== undefined && kept.id === sessionToResume(view, 'pi')) {
			this.context.acknowledgeThrough(kept.through);
			this.transcript = kept.id;
			return;
		}
		this.memory.kept = undefined;
		this.transcript = this.id;
	}

	/** Keep the transcript for the seat's next activation. A failed pass keeps nothing. */
	private keep(agent: PiAgent): void {
		if (this.stopped || this.transcript === undefined) return;
		this.memory.kept = {
			id: this.transcript,
			messages: [...agent.state.messages],
			through: this.readThrough,
		};
	}

	/**
	 * The record moved, but not in a way a model reads: a delta with no
	 * message in it. The session takes the view as read, and no run starts.
	 */
	private nothingNew(view: ActivationView): PassResult {
		this.context.acknowledgeThrough(view.through);
		return { failed: false };
	}

	/**
	 * The message that starts a run. The first pass hands the model the whole
	 * view. A later pass hands it the delta, and none when nothing is new.
	 */
	private promptFor(input: PassInput): AgentMessage | undefined {
		const resumed = this.resumedPrompt(input);
		if (resumed !== undefined) return resumed;
		if (input.kind === 'view') {
			const context = renderActivation(input.view, this.definition).context;
			return this.context.initial(input.view.through, context, this.now());
		}
		const text = renderDelta(input.view, input.since);
		if (text === undefined) return undefined;
		return this.context.delta(input.since, input.view.through, text, this.now());
	}

	/**
	 * The prompt of the first pass of an activation over a kept transcript:
	 * the record beyond what the transcript read. A closing activation and a
	 * pass with nothing new read the whole view.
	 */
	private resumedPrompt(input: PassInput): AgentMessage | undefined {
		const kept = this.memory.kept;
		if (input.kind !== 'view' || kept === undefined) return undefined;
		if (input.view.spec.purpose.kind !== 'respond') return undefined;
		const text = renderDelta(input.view, kept.through);
		if (text === undefined) return undefined;
		return this.context.delta(kept.through, input.view.through, text, this.now());
	}

	/**
	 * Tool events are room-visible. Pi context consumption is recorded at the
	 * provider request boundary by `PiContext`, not by transcript event text.
	 */
	private note(event: AgentEvent): void {
		for (const step of this.steps.steps(event)) this.trace.record(step);
		if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
			// `say` is the room's own event, not a tool's.
			if (event.toolName !== 'say') {
				this.emit({
					type: event.type,
					agent: this.definition.name,
					activation: this.id,
					toolName: event.toolName,
				});
			}
			return;
		}
	}

	/** Record the provider outcome and notify the host. */
	private executionFailure(agent: PiAgent): { error: Error; cause: FailureCause } | undefined {
		const failure = failureOf(agent);
		if (failure === undefined) return undefined;
		this.emit({
			type: 'error',
			agent: this.definition.name,
			activation: this.id,
			error: failure.error,
			cause: failure.cause,
		});
		return failure;
	}

	/**
	 * Record an execution failure and notify the host. A broken pass is a local
	 * fault, such as a lost room call or a build error, so its cause is
	 * transient and the room tries the activation again.
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

	/**
	 * The Pi agent of this activation. The first pass builds it: the executor
	 * renders the system prompt, resolves the definition's model, and binds
	 * the permitted tools. Later passes keep it, and give it the system
	 * prompt of the view now in hand. The stream function tells the activation
	 * when the model is asked, so a steer never joins the request it lands during.
	 */
	private async agentFor(view: ActivationView): Promise<PiAgent> {
		const def = this.definition;
		if (view.spec.seat !== def.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		const { mechanism, agent: seat } = renderActivation(view, def);
		const systemPrompt = `${mechanism}\n\n${seat}`;
		if (this.agent !== undefined) {
			this.agent.state.systemPrompt = systemPrompt;
			return this.agent;
		}
		const agent = new Agent({
			streamFn: (model, context, options) => {
				this.providerRequestStarted(context.messages);
				return this.stream(model, context, options);
			},
			initialState: {
				systemPrompt,
				model: await this.model(modelOf(def.executor), def.name),
				thinkingLevel: 'off',
				tools: toolsFor(view, def, binding(this, this.room), () => this.currentView(view)),
				messages: [...(this.memory.kept?.messages ?? [])],
			},
		});
		if (this.stopped) return agent;
		agent.subscribe((event) => this.note(event));
		this.agent = agent;
		return agent;
	}

	/** The view of the running pass, or the one the agent was built from. */
	private currentView(built: ActivationView): ActivationView {
		return this.view ?? built;
	}

	/**
	 * A provider request begins after Pi chose its input. A steer queued from
	 * here follows that request and cannot advance this request's progress.
	 * The seat side calls this from the stream function it hands Pi.
	 */
	private providerRequestStarted(messages: readonly object[]): void {
		this.context.providerRequestStarted(messages);
		this.providerStarted = true;
		for (const context of this.held.splice(0)) {
			if (this.agent === undefined) continue;
			this.context.steer(this.agent, context, this.now());
			this.trace.record({ type: 'steer', seq: context.seq, consumed: true });
		}
	}
}

/** The model identifier `pi()` gave the executor. Another family's executor has none. */
function modelOf(executor: AgentExecutor): string {
	if ('model' in executor && typeof executor.model === 'string') return executor.model;
	throw new Error(`The Pi executor cannot run an executor of kind '${executor.kind}'.`);
}

/** Whether the last model message stopped at a length limit. */
function endedForLength(agent: PiAgent): boolean {
	const last = agent.state.messages.at(-1);
	return last !== undefined && 'stopReason' in last && last.stopReason === 'length';
}

/** A failed provider message: name it in the error, and classify its cause. */
function failureOf(agent: PiAgent): { error: Error; cause: FailureCause } | undefined {
	const last = agent.state.messages.at(-1);
	if (last && 'stopReason' in last && last.stopReason === 'error') {
		const message = ('errorMessage' in last && last.errorMessage) || 'The activation failed.';
		return { error: new Error(message), cause: providerCause(last) };
	}
	return undefined;
}

/**
 * Whether a failed provider message is permanent or transient. A credit or an
 * authentication refusal in the text, or a permanent HTTP status a diagnostic
 * reports, is permanent. Every other failure is transient, so an uncertain
 * message retries rather than gives up: a wasted retry costs less than a
 * question the room drops.
 */
function providerCause(message: AgentMessage): FailureCause {
	const text = 'errorMessage' in message ? message.errorMessage : undefined;
	return classifyCause({ text, status: statusOf(message), permanent: PERMANENT_TEXT });
}

/** One provider diagnostic, as the classifier reads it. */
type Diagnostic = { error?: { code?: unknown }; details?: Record<string, unknown> };

/**
 * The HTTP status a diagnostic reports, or nothing. The classifier reads a
 * status only from a diagnostic, never from free error text, because a rate
 * limit names a token count that reads like a status. The last diagnostic
 * with a status wins, so a final attempt speaks for the failure.
 */
function statusOf(message: AgentMessage): number | undefined {
	const diagnostics: Diagnostic[] = 'diagnostics' in message ? (message.diagnostics ?? []) : [];
	let status: number | undefined;
	for (const diagnostic of diagnostics) {
		const found = diagnosticStatus(diagnostic);
		if (found !== undefined) status = found;
	}
	return status;
}

/** A status code one diagnostic reports, on its error code or its details. */
function diagnosticStatus(diagnostic: Diagnostic): number | undefined {
	const code = httpStatus(diagnostic.error?.code);
	if (code !== undefined) return code;
	const details = diagnostic.details ?? {};
	for (const key of ['status', 'statusCode', 'httpStatus']) {
		const value = httpStatus(details[key]);
		if (value !== undefined) return value;
	}
	return undefined;
}

/** A whole HTTP status, from a number or a fully numeric string, in the 4xx or 5xx range. */
function httpStatus(value: unknown): number | undefined {
	const parsed =
		typeof value === 'number'
			? value
			: typeof value === 'string' && /^\d+$/.test(value.trim())
				? Number(value.trim())
				: undefined;
	if (parsed === undefined || !Number.isInteger(parsed)) return undefined;
	return parsed >= 400 && parsed <= 599 ? parsed : undefined;
}

/** Error text that names a credit or an authentication refusal, in phrases a retry cannot clear. */
const PERMANENT_TEXT =
	/credit balance|authentication_error|permission_error|invalid_request_error|invalid[_\s]?api[_\s]?key|unauthorized|permission denied/i;
