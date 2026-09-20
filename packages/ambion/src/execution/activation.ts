/**
 * The Pi executor: one activation's session, from the pass the driver hands
 * it until the pass ends.
 *
 * A seat is seated for as long as the room runs. An activation lasts seconds,
 * and it owns what belongs to one:
 *
 * - **Its id.** Derived from the record: the message that woke the seat and
 *   the seat's name, or the close it answers and the attempt. Every call it
 *   makes carries it.
 * - **What it acknowledged.** `readThrough` is the highest contiguous
 *   position in provider input. A provider request or an accepted ordinary
 *   say advances it. Rule 5 refuses a draft against a newer record.
 * - **What arrived while it worked.** A message that lands mid-activation is steered
 *   in. It reaches the provider after the request it lands during. PiContext
 *   records the structured range only when that later request receives it.
 *
 * The driver hands a session one view per pass; the session renders the
 * prompt, resolves the model and binds the tools, runs it, and reports where
 * it left off.
 *
 * **Three spans, and only two are ours.** Pi has a *turn* — one request to a
 * provider and the tools it calls — and a *run*, which is one `prompt()` and
 * the turns inside it. An activation is wider than both: it is one or more
 * runs, because a message landing mid-activation rebuilds it against the
 * record as it now stands. The word for what a room does to a seat is
 * `activation` ([`agent.md`](../../../docs/agent.md) rule 1), and the record
 * has called it that all along: every one lands in the seat's downstream
 * session as an `ambion/activation` entry.
 */
import type { AuditSession as PiSession, SessionOpener } from '@ambionframework/pi-journal';
import type {
	AgentEvent,
	AgentMessage,
	Agent as PiAgent,
	StreamFn,
} from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { ActivationView, RoomProtocol } from '../protocol.ts';
import type {
	AgentDefinition,
	ExecutionEvent,
	FailureCause,
	ModelResolver,
	Seq,
} from '../types.ts';
import type { Executor, ExecutorActivation, ExecutorSession, PassResult } from './executor.ts';
import { PiContext } from './pi.ts';
import { renderActivation } from './render.ts';
import { seatSessionId } from './services.ts';
import { binding, toolsFor } from './tools.ts';

/** What builds a Pi executor for one seat: its definition, and the room's model services. */
export interface PiExecutorOptions {
	readonly definition: AgentDefinition;
	readonly model: ModelResolver;
	readonly stream: StreamFn;
	readonly transcripts: SessionOpener;
	readonly room: string;
	/** The room's clock. Pi stamps every message it is handed with it. */
	readonly now: () => number;
}

/** The Pi executor. One instance per seat, for as long as the room runs. */
export function createPiExecutor(options: PiExecutorOptions): Executor {
	let audit: Promise<PiSession> | undefined;
	const openAudit = (): Promise<PiSession> => {
		if (audit !== undefined) return audit;
		const id = seatSessionId(options.room, options.definition.name);
		const opening = options.transcripts.open(id, options.room);
		const retained: Promise<PiSession> = opening.then(
			(session) => session,
			(error: unknown) => {
				if (audit === retained) audit = undefined;
				throw error;
			},
		);
		audit = retained;
		return retained;
	};
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options, openAudit);
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
	private readonly openAudit: () => Promise<PiSession>;
	/** How much record context the provider consumed. */
	private readonly context = new PiContext();
	/** The steers held before Pi first polls its queue. */
	private held: { after: Seq; seq: Seq; line: string }[] = [];
	private providerStarted = false;
	private agent: PiAgent | undefined;
	private stopped = false;

	constructor(
		activation: ExecutorActivation,
		options: PiExecutorOptions,
		openAudit: () => Promise<PiSession>,
	) {
		this.id = activation.id;
		this.room = activation.room;
		this.emit = activation.emit;
		this.definition = options.definition;
		this.model = options.model;
		this.stream = options.stream;
		this.now = options.now;
		this.openAudit = openAudit;
	}

	/** The seq this activation may commit against: rule 5's `readThrough`. */
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
	 * steer (rule 2). PiContext records its range without parsing rendered text.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		const context = { after, seq, line };
		if (this.providerStarted && this.agent !== undefined) {
			this.context.steer(this.agent, context, this.now());
		} else {
			this.held.push(context);
		}
	}

	/** Pi's abort ends the run but not its queues; the driver stops rebuilding it too. */
	abort(): void {
		this.stopped = true;
		this.agent?.abort();
	}

	/**
	 * Whether the record moved past acknowledged context. A queued steer or a
	 * newer room position requires a fresh pass. A dropped steer stays on the
	 * record and is delivered again by that later pass's view. A cancelled
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
	async pass(view: ActivationView): Promise<PassResult> {
		try {
			if (this.stopped) return { failed: false };
			// The fresh view becomes acknowledged only when Pi sends it to a provider.
			this.held = [];
			this.providerStarted = false;
			const built = await this.build(view);
			if (this.stopped) return { failed: false };
			const { agent, context } = built;
			this.agent = agent;
			agent.subscribe((event) => this.note(event));
			await agent.prompt(this.context.initial(view.through, context, this.now()));
			const failure = this.executionFailure(agent);
			await this.audit(agent);
			return failure === undefined ? { failed: false } : { failed: true, cause: failure.cause };
		} catch (error) {
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		}
	}

	/**
	 * Tool events are room-visible. Pi context consumption is recorded at the
	 * provider request boundary by `PiContext`, not by transcript event text.
	 */
	private note(event: AgentEvent): void {
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

	/** Record the provider outcome before audit I/O can delay a lease release. */
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

	/** Audit failure is diagnostic only. It never changes the provider outcome. */
	private async audit(agent: PiAgent): Promise<void> {
		try {
			await persistTurns(this.openAudit, agent, new Date(this.now()).toISOString());
		} catch (error) {
			try {
				this.emit({
					type: 'audit_error',
					agent: this.definition.name,
					activation: this.id,
					error: asError(error),
				});
			} catch {
				// Audit diagnostics must never change the execution outcome.
			}
		}
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
		return { failed: true, cause: 'transient' };
	}

	/**
	 * The model over the view: the executor renders the prompt, resolves the
	 * definition's model, and binds the permitted tools. The stream function tells the activation
	 * when the model is asked, so a steer never joins the request it lands during.
	 */
	private async build(view: ActivationView): Promise<{ agent: PiAgent; context: string }> {
		const def = this.definition;
		if (view.spec.seat !== def.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		const rendered = renderActivation(view, def);
		const agent = new Agent({
			streamFn: (model, context, options) => {
				this.providerRequestStarted(context.messages);
				return this.stream(model, context, options);
			},
			initialState: {
				systemPrompt: rendered.systemPrompt,
				model: await this.model(def.executor.model, def.name),
				thinkingLevel: 'off',
				tools: toolsFor(view, def, binding(this, this.room)),
				messages: [],
			},
		});
		return { agent, context: rendered.context };
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
			if (this.agent !== undefined) this.context.steer(this.agent, context, this.now());
		}
	}
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

/** HTTP statuses a retry cannot fix: a bad request, a billing refusal, and the authentication refusals. */
const PERMANENT_STATUS = new Set([400, 401, 402, 403, 404, 405, 422]);

/**
 * Whether a failed provider message is permanent or transient. A credit or an
 * authentication refusal in the text, or a permanent HTTP status a diagnostic
 * reports, is permanent. Every other failure is transient, so an uncertain
 * message retries rather than gives up: a wasted retry costs less than a
 * question the room drops.
 */
function providerCause(message: AgentMessage): FailureCause {
	if (permanentText('errorMessage' in message ? message.errorMessage : undefined))
		return 'permanent';
	const status = statusOf(message);
	return status !== undefined && PERMANENT_STATUS.has(status) ? 'permanent' : 'transient';
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
function permanentText(text: string | undefined): boolean {
	if (text === undefined) return false;
	return /credit balance|authentication_error|permission_error|invalid_request_error|invalid[_\s]?api[_\s]?key|unauthorized|permission denied/i.test(
		text,
	);
}

/** Every turn a model took, in the downstream session that owns it. */
export async function persistTurns(
	open: () => Promise<PiSession>,
	agent: PiAgent,
	at: string,
): Promise<void> {
	const batch = crypto.randomUUID();
	const messages = agent.state.messages.map((message) => {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		return JSON.parse(JSON.stringify(message)) as AgentMessage;
	});
	for (let attempt = 0; attempt < AUDIT_ATTEMPTS; attempt += 1) {
		try {
			const piSeat = await open();
			await piSeat.appendEntry(
				{
					type: 'custom',
					id: `${batch}:activation`,
					customType: 'ambion/activation',
					data: { at },
				},
				'main',
			);
			for (const [index, message] of messages.entries()) {
				await piSeat.appendEntry(
					{
						type: 'message',
						id: `${batch}:message:${index}`,
						message,
					},
					'main',
				);
			}
			return;
		} catch (error) {
			if (attempt === AUDIT_ATTEMPTS - 1) throw error;
		}
	}
}

/** Audit gets one retry for a lost or refused write in this activation. */
const AUDIT_ATTEMPTS = 2;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
