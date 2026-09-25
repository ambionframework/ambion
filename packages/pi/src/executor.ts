/**
 * The Pi executor: one activation's session, from the pass the driver hands
 * it until the activation stops.
 *
 * Pi's `AgentHarness` owns the model loop, the session, its persistence and
 * its compaction. The driver's contract is pass in and result out, so the
 * first pass of an activation opens one harness over the seat's session,
 * and each pass prompts its lane once and resolves when the run ends.
 *
 * - **Freshness.** `readThrough` is the highest contiguous position that a
 *   provider request held. Each range of the record goes into the session
 *   as a custom message that carries its positions. The harness hook that
 *   builds the provider input reads them from the exact messages of each
 *   request. An accepted ordinary say also advances it. Freshness refuses a
 *   draft against a newer record.
 * - **Steer.** A line that lands during a run goes to the lane as a steer.
 *   It counts as consumed when a provider request holds it. A line that
 *   lands before the run starts joins the prompt. A line that finds no pass
 *   waits for the record: the next delta carries it.
 * - **Cut.** `abort` aborts the run. `close` closes the harness and the
 *   session, and the driver calls it when the activation is over.
 * - **Exchange continuity.** A session carries the id of the activation
 *   that began it, and the release records that id. The activation reopens
 *   the session that `spec.resume` names, which the room hands back inside
 *   one exchange, and prompts it with the record beyond the position the
 *   session read through. A session the store cannot open starts fresh.
 *   The lane goes back to the last position the session read, so a failed
 *   run leaves the provider input.
 *
 * **Three spans, and only two are ours.** Pi has a *turn*, which is one
 * request to a provider and the tools it calls, and a *run*, which is one
 * prompt and the turns inside it. An activation is wider than both: it is
 * one or more runs, because a message landing mid-activation starts another
 * run over the record as it now stands. The word for what a room does to a
 * seat is `activation` ([`agent.md`](../../../docs/agent.md), Execution
 * boundary), and the lease entries and the trace of each one carry that word.
 */
import type {
	ActivationView,
	AgentDefinition,
	ExecutionEvent,
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
	renderPending,
	resolveReminders,
	sessionToResume,
} from '@ambionframework/ambion/hosting';
import type { AgentMessage, HarnessEvent, Session, StreamFn } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, getOrUndefined } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { compactionOf, modelOf, thinkingOf } from './define.ts';
import { passOutcome } from './failure.ts';
import { Freshness, providerMessages, READ, recordMessage } from './freshness.ts';
import { type OpenHarness, openHarness } from './harness.ts';
import { streamModels } from './models.ts';
import { PiSteps } from './pi-trace.ts';
import type { ModelResolver } from './services.ts';
import { memorySessions, type PiSessions, type SessionScope } from './sessions.ts';
import { binding, toolsFor } from './tools.ts';

const CONTEXT = BACKGROUND_CONTEXT;

/** What builds a Pi executor for one seat: its definition, and the room's model services. */
export interface PiExecutorOptions {
	readonly definition: AgentDefinition;
	readonly model: ModelResolver;
	readonly stream: StreamFn;
	/** The room's clock. The session stamps every range of the record with it. */
	readonly now: () => number;
	/** Where the seat keeps its sessions. Absent, in memory for as long as the executor lives. */
	readonly sessions?: PiSessions;
}

/** What the activations of one seat share. */
export interface Seat {
	readonly sessions: PiSessions;
	/** The close of each session an ended activation still holds, by id. */
	readonly closing: Map<string, Promise<void>>;
}

/** The Pi executor. One instance per seat, for as long as the room runs. */
export function createPiExecutor(options: PiExecutorOptions): Executor {
	const seat: Seat = { sessions: options.sessions ?? memorySessions(), closing: new Map() };
	return {
		open(activation: ExecutorActivation): ExecutorSession {
			return new Activation(activation, options, seat);
		},
	};
}

/** A steered line held until its pass prompts the lane. */
interface Held {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

/** The harness of an activation, and the session under it. */
interface Opened extends OpenHarness {
	readonly session: Session;
}

const noop = () => {};

/** One activation, from the moment the room wakes a seat until it stops. */
export class Activation implements ExecutorSession {
	readonly id: string;
	private readonly room: RoomProtocol;
	private readonly emit: (event: ExecutionEvent) => void;
	private readonly definition: AgentDefinition;
	private readonly options: PiExecutorOptions;
	private readonly seat: Seat;
	/** The sink for the steps this executor owns. The driver closes it. */
	private readonly trace: TraceSink;
	private readonly steps = new PiSteps();
	private readonly freshness = new Freshness();
	/** The harness of this activation. The first pass opens it, and `close` closes it. */
	private opened: Opened | undefined;
	/** The id of the session this activation opened. */
	private sessionId: string | undefined;
	/** The position a continued session read through, when the activation continues one. */
	private base: Seq | undefined;
	private systemPrompt = '';
	/** The view of the running pass. The tools read the room and exchange from it. */
	private view: ActivationView | undefined;
	/**
	 * Where the pass stands: no pass, a pass that prepares its run, or a run.
	 * A steer takes a different path in each.
	 */
	private phase: 'idle' | 'starting' | 'running' = 'idle';
	/** How many passes began. */
	private passes = 0;
	/** The steers that landed before the first pass. */
	private early: Seq[] = [];
	/** The steers that landed while a pass prepared its run. */
	private held: Held[] = [];
	/** The steered lines no provider request has held yet, by position, with their queue entry. */
	private readonly steered = new Map<Seq, Promise<string | undefined>>();
	/** The last assistant message of the running run. */
	private last: AssistantMessage | undefined;
	private stopped = false;
	private closed = false;
	/** Resolves when the activation is cut. */
	private readonly cut: Promise<void>;
	private cutNow: () => void = noop;

	constructor(activation: ExecutorActivation, options: PiExecutorOptions, seat: Seat) {
		this.id = activation.id;
		this.room = activation.room;
		this.emit = activation.emit;
		this.trace = activation.trace;
		this.definition = options.definition;
		this.options = options;
		this.seat = seat;
		this.cut = new Promise((resolve) => {
			this.cutNow = resolve;
		});
	}

	/** The session to record with the release. Absent until a pass opens one. */
	get session(): HarnessSession | undefined {
		const id = this.sessionId;
		return id === undefined ? undefined : { harness: 'pi', id };
	}

	/** The seq this activation may commit against: the freshness boundary `readThrough`. */
	get readThrough(): Seq {
		return this.freshness.readThrough;
	}

	/** Whether `abort` was called. The driver checks this before another room round trip. */
	get cancelled(): boolean {
		return this.stopped;
	}

	/** An accepted ordinary say confirms this activation consumed the record through here. */
	acknowledgeThrough(seq: Seq): void {
		this.freshness.acknowledgeThrough(seq);
	}

	/** A rejected commit placed this record in the next tool result the model reads. */
	toolResultExpected(toolCallId: string, seq: Seq): void {
		this.freshness.toolResultExpected(toolCallId, seq);
	}

	/**
	 * A line landed while this activation worked. A run takes it as a steer.
	 * A pass that prepares its run adds it to the prompt. With no pass, it
	 * waits for the record: the next delta has it.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.stopped) return;
		if (this.phase === 'idle' && this.passes === 0) {
			// The first pass reads the record as it stands then.
			this.early.push(seq);
		} else if (this.phase === 'idle') {
			this.trace.record({ type: 'steer', seq, consumed: false });
		} else if (this.phase === 'starting' || this.opened === undefined) {
			this.held.push({ after, seq, line });
		} else {
			this.send(this.opened, { after, seq, line });
		}
	}

	/** Whether the record moved past what the model read. */
	shouldRefresh(lastSeq: Seq): boolean {
		return !this.stopped && lastSeq > this.readThrough;
	}

	/** Abort the run. The pass in flight ends, and the driver runs no other. */
	abort(): void {
		this.stopped = true;
		this.cutNow();
		this.opened?.lane.abort(CONTEXT).catch(noop);
	}

	/** Close the harness and its session. The driver calls this once the activation is over. */
	close(): void {
		this.stopped = true;
		this.closed = true;
		this.cutNow();
		this.release();
	}

	/** One pass: read, act, and report where this session left off. */
	async pass(input: PassInput): Promise<PassResult> {
		if (this.stopped) return { failed: false };
		this.passes += 1;
		this.drop(this.early.splice(0));
		this.phase = 'starting';
		this.view = input.view;
		try {
			return await this.runPass(input);
		} catch (error) {
			// A cut closes the harness under the run. What it throws then is no failure.
			if (this.stopped) return { failed: false };
			await this.renew(input.view);
			return this.broke(error instanceof Error ? error : new Error(String(error)));
		} finally {
			this.phase = 'idle';
			this.drop(this.held.splice(0).map((held) => held.seq));
		}
	}

	/** Open the harness, and prompt it with what the pass has to read. */
	private async runPass(input: PassInput): Promise<PassResult> {
		const opened = await this.prepare(input.view);
		if (opened === undefined || this.stopped) return { failed: false };
		const prompt = [...(await this.promptFor(input)), ...this.flush(input.view.through)];
		if (prompt.length === 0) return this.nothingNew(opened, input.view);
		return this.run(opened, prompt);
	}

	/** Steers that reached no model. The record holds them for the next pass. */
	private drop(seqs: readonly Seq[]): void {
		for (const seq of seqs) this.trace.record({ type: 'steer', seq, consumed: false });
	}

	/**
	 * The harness of this activation. The first pass renders the system
	 * prompt, resolves the definition's model, opens the session, and binds
	 * the permitted tools. Later passes keep it, and give it the system prompt
	 * of the view now in hand.
	 */
	private async prepare(view: ActivationView): Promise<Opened | undefined> {
		const def = this.definition;
		if (view.spec.seat !== def.name)
			throw new Error(`Activation names another seat: '${view.spec.seat}'.`);
		const { mechanism, agent } = renderActivation(view, def);
		this.systemPrompt = `${mechanism}\n\n${agent}`;
		if (this.opened !== undefined) return this.opened;
		const model = await this.options.model(modelOf(def.executor), def.name);
		if (this.stopped) return undefined;
		const opened = this.hold(await this.openSession(view, model));
		if (opened === undefined) return undefined;
		try {
			await this.readBase(opened, view);
			return opened;
		} catch {
			// The session is a cache: a session that fails here gives way to a fresh one.
			this.release();
			return this.hold(await this.attach(await this.fresh(view), view, model));
		}
	}

	/** Take the harness as this activation's, unless the activation closed while it opened. */
	private hold(opened: Opened): Opened | undefined {
		this.sessionId = opened.session.metadata.id;
		this.opened = opened;
		if (!this.closed) return opened;
		this.release();
		return undefined;
	}

	/** A fresh session under this activation's id. */
	private fresh(view: ActivationView): Promise<Session> {
		return this.seat.sessions.create(scopeOf(view, this.definition), this.id, CONTEXT);
	}

	/**
	 * A harness over the session `spec.resume` names, or over a fresh session
	 * under this activation's id. A session that does not open, or that the
	 * harness cannot attach to, closes, and a fresh session takes its place.
	 */
	private async openSession(view: ActivationView, model: Model<Api>): Promise<Opened> {
		const resumed = await this.resumed(scopeOf(view, this.definition), view);
		if (resumed !== undefined) {
			const opened = await this.attach(resumed, view, model).catch(() => undefined);
			if (opened !== undefined) return opened;
		}
		return this.attach(await this.fresh(view), view, model);
	}

	/** The session `spec.resume` names, once the activation that held it closed it. */
	private async resumed(scope: SessionScope, view: ActivationView): Promise<Session | undefined> {
		const resume = sessionToResume(view, 'pi');
		if (resume === undefined) return undefined;
		// An ended activation may still close the session, and a session opens once.
		// A cut ends the wait.
		await Promise.race([this.seat.closing.get(resume), this.cut]);
		return this.seat.sessions.open(scope, resume, CONTEXT);
	}

	/** A harness over the session, with the tools of this activation. A failed attach closes the session. */
	private async attach(session: Session, view: ActivationView, model: Model<Api>): Promise<Opened> {
		const def = this.definition;
		const tools = toolsFor(view, def, binding(this, this.room), () => this.view ?? view);
		try {
			const opened = await openHarness({
				session,
				models: streamModels(model, this.options.stream),
				model,
				tools,
				systemPrompt: () => this.systemPrompt,
				compaction: compactionOf(def.executor),
				thinking: thinkingOf(def.executor),
				toProviderMessages: (messages) => this.provide(messages),
				onEvent: (event) => this.note(event),
			});
			return { ...opened, session };
		} catch (error) {
			await session.close(CONTEXT).catch(noop);
			throw error;
		}
	}

	/**
	 * In a continued session, start from the position it read through. The
	 * lane goes back to the entry that holds that position: a run that
	 * failed or was cut after it leaves the provider input, and the record it
	 * held comes again in the delta. With no such entry, the lane goes back
	 * to the root, and the activation reads the whole view once.
	 */
	private async readBase(opened: Opened, view: ActivationView): Promise<void> {
		if (sessionToResume(view, 'pi') === undefined) return;
		const entry = await opened.lane.findEntry(
			{ type: 'custom', customType: READ, order: 'newestFirst' },
			CONTEXT,
		);
		const through = entry?.type === 'custom' ? positionOf(entry.data) : undefined;
		if (entry === undefined || through === undefined) {
			await rewind(opened, null);
			return;
		}
		await rewind(opened, entry.id);
		this.base = through;
		this.freshness.acknowledgeThrough(through);
	}

	/**
	 * The ranges of the record that start a run. The first pass hands the
	 * model the whole view. A later pass, and a response in a continued
	 * session, hand it the delta, and none when nothing is new. The first
	 * pass of a response in a continued session also hands it the reminders
	 * of the tool bundles and the seat's pending says, which the whole view
	 * holds. A closing activation reads the whole view.
	 */
	private async promptFor(input: PassInput): Promise<AgentMessage[]> {
		const { view } = input;
		const after = input.kind === 'delta' ? input.since : this.base;
		if (after !== undefined && (input.kind === 'delta' || view.spec.purpose.kind === 'respond')) {
			const delta = renderDelta(view, after);
			if (delta === undefined) return [];
			// The bundle reminders resolve only when the pass has something to send.
			const first = input.kind !== 'delta';
			const reminders = first ? await resolveReminders(view, this.definition) : undefined;
			const pending = first ? renderPending(view) : undefined;
			const text = [reminders, pending, delta].filter((part) => part !== undefined).join('\n\n');
			return [recordMessage({ after, through: view.through }, text, this.options.now())];
		}
		const reminders = await resolveReminders(view, this.definition);
		const text = renderActivation(view, this.definition, reminders).context;
		return [recordMessage({ after: 0, through: view.through }, text, this.options.now())];
	}

	/**
	 * The steers held while the pass prepared its run. A line the view holds
	 * reached the model with it. Any other joins the prompt.
	 */
	private flush(through: Seq): AgentMessage[] {
		const now = this.options.now();
		return this.held.splice(0).flatMap((held) => {
			if (held.seq <= through) {
				this.trace.record({ type: 'steer', seq: held.seq, consumed: true });
				return [];
			}
			this.steered.set(held.seq, Promise.resolve(undefined));
			return [steerMessage(held, now)];
		});
	}

	/** Queue a steer on the running lane. */
	private send(opened: Opened, held: Held): void {
		const queued = opened.lane
			.steer(steerMessage(held, this.options.now()), undefined, CONTEXT)
			.then((result) => getOrUndefined(result)?.entryId)
			.catch(() => undefined);
		this.steered.set(held.seq, queued);
	}

	/** One run over the prompt, and what it means for the pass. */
	private async run(opened: Opened, prompt: AgentMessage[]): Promise<PassResult> {
		this.last = undefined;
		this.phase = 'running';
		const result = await opened.lane.prompt(prompt, CONTEXT);
		this.phase = 'idle';
		await this.settle(opened);
		// A cut run is no failure, whatever the closed harness answers.
		if (this.stopped) return { failed: false };
		const outcome = passOutcome(result, this.last);
		if (outcome.failed) {
			this.emit({
				type: 'error',
				agent: this.definition.name,
				activation: this.id,
				error: outcome.error,
				cause: outcome.cause,
			});
			return { failed: true, cause: outcome.cause, message: outcome.error.message };
		}
		await this.remember(opened);
		return outcome.stop === undefined ? { failed: false } : { failed: false, stop: outcome.stop };
	}

	/**
	 * The steers no provider request held once the run ended. Each leaves the
	 * lane queue, and the record holds it for the next delta.
	 */
	private async settle(opened: Opened): Promise<void> {
		const left = [...this.steered];
		this.steered.clear();
		for (const [seq, queued] of left) {
			const entryId = await queued;
			if (entryId !== undefined) await opened.lane.cancelQueued(entryId, CONTEXT).catch(noop);
			this.trace.record({ type: 'steer', seq, consumed: false });
		}
	}

	/**
	 * The record moved, but not in a way a model reads: a delta with no
	 * message in it. The session takes the view as read, and no run starts.
	 */
	private async nothingNew(opened: Opened, view: ActivationView): Promise<PassResult> {
		this.freshness.acknowledgeThrough(view.through);
		await this.remember(opened);
		return { failed: false };
	}

	/**
	 * Write the position the session read through, for the activation that
	 * continues it. The session is a cache: when the write fails, the next
	 * activation reads the whole view, and this one runs on.
	 */
	private async remember(opened: Opened): Promise<void> {
		await opened.lane.appendCustomEntry(READ, { through: this.readThrough }, CONTEXT).catch(noop);
	}

	/** The provider messages of one request, and what they hold of the record. */
	private provide(messages: AgentMessage[]): Message[] {
		for (const seq of this.freshness.provided(messages)) {
			if (this.steered.delete(seq)) this.trace.record({ type: 'steer', seq, consumed: true });
		}
		return providerMessages(messages);
	}

	/** One harness event: its steps, and the room-visible tool events. */
	private note(event: HarnessEvent): void {
		for (const step of this.steps.steps(event)) this.trace.record(step);
		if (event.type === 'message_end' && event.message.role === 'assistant') {
			this.last = event.message;
		}
		if (event.type !== 'tool_start' && event.type !== 'tool_end') return;
		// `say` is the room's own event, not a tool's.
		if (event.toolName === 'say') return;
		this.emit({
			type: event.type === 'tool_start' ? 'tool_execution_start' : 'tool_execution_end',
			agent: this.definition.name,
			activation: this.id,
			toolName: event.toolName,
		});
	}

	/** Close the harness and its session, and let the seat's next activation wait for it. */
	private release(): void {
		const opened = this.opened;
		if (opened === undefined) return;
		this.opened = undefined;
		this.closing(opened.session.metadata.id, opened.harness.close(CONTEXT));
	}

	/** Let the seat's next activation wait for the close of the session `id`. */
	private closing(id: string, close: Promise<void>): void {
		const { closing } = this.seat;
		const done = close.catch(noop);
		closing.set(id, done);
		void done.then(() => {
			if (closing.get(id) === done) closing.delete(id);
		});
	}

	/**
	 * A pass broke: the fault is local, such as a session store that fails a
	 * write, and the harness throws it. The retry must not continue this
	 * session, so the release records a fresh, empty one. The retry reads
	 * the whole view. With no fresh session, the release records none.
	 */
	private async renew(view: ActivationView): Promise<void> {
		if (this.sessionId === undefined) return;
		this.release();
		this.sessionId = undefined;
		const fresh = await this.fresh(view).catch(() => undefined);
		if (fresh === undefined) return;
		this.sessionId = fresh.metadata.id;
		this.closing(fresh.metadata.id, fresh.close(CONTEXT));
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
}

/** The room and seat a session belongs to. */
function scopeOf(view: ActivationView, definition: AgentDefinition): SessionScope {
	return { room: view.context.name, seat: definition.name };
}

/** Move the lane tip to `target`, the root when null, unless it stands there. */
async function rewind(opened: Opened, target: string | null): Promise<void> {
	if ((await opened.lane.getTipId(CONTEXT)) === target) return;
	await opened.lane.navigateTree(target, { summarize: false }, CONTEXT);
}

/** A steered line as a range of the record. */
function steerMessage(held: Held, now: number): AgentMessage {
	return recordMessage(
		{ after: held.after, through: held.seq, steer: true },
		`[new] ${held.line}`,
		now,
	);
}

/** The position a read entry holds. */
function positionOf(data: unknown): Seq | undefined {
	if (typeof data !== 'object' || data === null || !('through' in data)) return undefined;
	return typeof data.through === 'number' ? data.through : undefined;
}
