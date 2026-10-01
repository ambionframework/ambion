/**
 * The Pi opener: it opens one running activation, which takes each pass the
 * driver hands it until the activation stops.
 *
 * Pi's `AgentHarness` owns the model loop, the session, its persistence and
 * its compaction. The driver's contract is pass in and result out, so the
 * first pass of an activation opens one harness over the seat's session,
 * and each pass prompts its lane once and resolves when the pass ends.
 *
 * - **Freshness.** The core keeps `readThrough`. Each range of the record
 *   goes into the session as a custom message that carries its positions.
 *   The harness hook that builds the provider input reads them from the
 *   exact messages of each request, and tells the core each range and each
 *   tool result that the request holds.
 * - **Steer.** A line that lands during a pass goes to the lane as a steer.
 *   It counts as consumed when a provider request holds it. A line that
 *   lands before the pass starts joins the prompt. The core records the
 *   `steer` step ([`executors.md`](../../../docs/executors.md)), and a line
 *   the pass does not read waits for the next delta.
 * - **Cut.** The signal of the activation aborts the pass. `close` closes the
 *   harness and the session, and the driver calls it when the activation is
 *   over.
 * - **Exchange continuity.** A session carries the id of the activation
 *   that began it, and the release records that id. The activation reopens
 *   the session that `spec.resume` names, which the room hands back inside
 *   one exchange, and prompts it with the record beyond the position the
 *   session read through. A session the store cannot open starts fresh.
 *   The lane goes back to the last position the session read, so a failed
 *   pass leaves the provider input.
 *
 * **Three spans, and only two are ours.** Pi has a *turn*, which is one
 * request to a provider and the tools it calls, and a *run*, which is one
 * prompt and the turns inside it. A pass is one Pi run. An activation is
 * wider than both: it is one or more passes, because a message landing
 * mid-activation starts another pass over the record as it now stands. The word for what a room does to a
 * seat is `activation` ([`agent.md`](../../../docs/agent.md), Execution
 * boundary), and the lease entries and the trace of each one carry that word.
 */
import type {
	ActivationOpener,
	ActivationView,
	AgentDefinition,
	ExecutorActivation,
	Pass,
	PassResult,
	RunningActivation,
	Seq,
} from '@ambionframework/ambion/hosting';
import { failedPass } from '@ambionframework/ambion/hosting';
import type { AgentMessage, HarnessEvent, Session } from '@earendil-works/pi-agent-core';
import { BACKGROUND_CONTEXT, getOrUndefined } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { compactionOf, modelOf, thinkingOf } from './define.ts';
import { passOutcome } from './failure.ts';
import { provided, providerMessages, READ, recordMessage } from './freshness.ts';
import { type OpenHarness, openHarness } from './harness.ts';
import { streamModels } from './models.ts';
import { PiSteps } from './pi-trace.ts';
import type { ExecutionServices } from './services.ts';
import type { PiSessions, SessionScope } from './sessions.ts';
import { toolsFor } from './tools.ts';

const CONTEXT = BACKGROUND_CONTEXT;

/** What builds a Pi opener for one seat: its definition, and the room's services. */
export interface PiOpenerOptions extends ExecutionServices {
	readonly definition: AgentDefinition;
	/** The room's clock. The session stamps every range of the record with it. */
	readonly now: () => number;
}

/** What the activations of one seat share. */
interface Seat {
	readonly sessions: PiSessions;
	/** The close of each session an ended activation still holds, by id. */
	readonly closing: Map<string, Promise<void>>;
}

/** The Pi opener. One instance per seat, for as long as the room runs. */
export function createPiOpener(options: PiOpenerOptions): ActivationOpener {
	const seat: Seat = { sessions: options.sessions, closing: new Map() };
	return (activation: ExecutorActivation): RunningActivation =>
		new Activation(activation, options, seat);
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
class Activation implements RunningActivation {
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly options: PiOpenerOptions;
	private readonly seat: Seat;
	private readonly steps = new PiSteps();
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
	 * Where the pass stands: `starting` prepares its prompt, `running` waits
	 * on its prompt, and `idle` is any other time. A steer takes a different path in
	 * each.
	 */
	private phase: 'idle' | 'starting' | 'running' = 'idle';
	/** The steers that landed while a pass prepared its prompt. */
	private held: Held[] = [];
	/** The queue entry of each steered line that no provider request holds yet, by position. */
	private readonly steered = new Map<Seq, Promise<string | undefined>>();
	/** The last assistant message of the running pass. */
	private last: AssistantMessage | undefined;
	private stopped = false;
	private closed = false;
	/** Resolves when the activation is cut. */
	private readonly cut: Promise<void>;
	private cutNow: () => void = noop;

	constructor(activation: ExecutorActivation, options: PiOpenerOptions, seat: Seat) {
		this.activation = activation;
		this.definition = options.definition;
		this.options = options;
		this.seat = seat;
		this.cut = new Promise((resolve) => {
			this.cutNow = resolve;
		});
		activation.signal.addEventListener('abort', () => this.abort(), { once: true });
	}

	/** The id of the session to record with the release. Absent until a pass opens one. */
	get session(): string | undefined {
		return this.sessionId;
	}

	/** The sink for the steps this executor owns. */
	private get trace() {
		return this.activation.trace;
	}

	/**
	 * A line landed while a pass runs. A running pass takes it as a steer. A pass that
	 * prepares its prompt adds the line to it. After the pass, the line waits
	 * for the record: the next delta has it.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.phase === 'starting') this.held.push({ after, seq, line });
		else if (this.phase === 'running' && this.opened !== undefined) {
			this.send(this.opened, { after, seq, line });
		}
	}

	/** The activation was cut: abort the pass. The pass in flight ends. */
	private abort(): void {
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
	async pass(pass: Pass): Promise<PassResult> {
		this.phase = 'starting';
		this.view = pass.view;
		this.systemPrompt = `${pass.mechanism}\n\n${pass.agent}`;
		try {
			return await this.runPass(pass);
		} catch (error) {
			// A cut closes the harness under the pass. What it throws then is no failure.
			if (this.stopped) return { failed: false };
			await this.renew(pass.view);
			// A local fault, such as a lost room call or an unknown model. `failedPass` sets the cause.
			return failedPass(error);
		} finally {
			this.phase = 'idle';
			// A line the pass never prompted waits for the next delta.
			this.held = [];
		}
	}

	/**
	 * Open the harness, and prompt it with what the pass has to read. A pass
	 * with nothing new starts no prompt.
	 */
	private async runPass(pass: Pass): Promise<PassResult> {
		const opened = await this.prepare(pass);
		if (opened === undefined || this.stopped) return { failed: false };
		const record = await pass.record(this.base);
		const now = this.options.now();
		const prompt = [
			...(record === undefined ? [] : [recordMessage(record.range, record.text, now)]),
			...this.flush(),
		];
		if (prompt.length === 0) return this.nothingNew(opened);
		return this.run(opened, prompt);
	}

	/**
	 * The harness of this activation. The first pass resolves the definition's
	 * model, opens the session, and holds the tools of the pass. Later passes
	 * keep it.
	 */
	private async prepare(pass: Pass): Promise<Opened | undefined> {
		if (this.opened !== undefined) return this.opened;
		const def = this.definition;
		const model = await this.options.model(modelOf(def.executor), def.name);
		if (this.stopped) return undefined;
		const opened = this.hold(await this.openSession(pass, model));
		if (opened === undefined) return undefined;
		try {
			await this.readBase(opened, pass);
			return opened;
		} catch {
			// The session is a cache: a session that fails here gives way to a fresh one.
			this.release();
			return this.hold(await this.attach(await this.fresh(pass.view), pass, model));
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
		return this.seat.sessions.create(scopeOf(view, this.definition), this.activation.id, CONTEXT);
	}

	/**
	 * A harness over the session `spec.resume` names, or over a fresh session
	 * under this activation's id. A session that does not open, or that the
	 * harness cannot attach to, closes, and a fresh session takes its place.
	 */
	private async openSession(pass: Pass, model: Model<Api>): Promise<Opened> {
		const resumed = await this.resumed(scopeOf(pass.view, this.definition), pass.resume);
		if (resumed !== undefined) {
			const opened = await this.attach(resumed, pass, model).catch(() => undefined);
			if (opened !== undefined) return opened;
		}
		return this.attach(await this.fresh(pass.view), pass, model);
	}

	/** The session `spec.resume` names, once the activation that held it closed it. */
	private async resumed(
		scope: SessionScope,
		resume: string | undefined,
	): Promise<Session | undefined> {
		if (resume === undefined) return undefined;
		// An ended activation may still close the session, and a session opens once.
		// A cut ends the wait.
		await Promise.race([this.seat.closing.get(resume), this.cut]);
		return this.seat.sessions.open(scope, resume, CONTEXT);
	}

	/** A harness over the session, with the tools of this activation. A failed attach closes the session. */
	private async attach(session: Session, pass: Pass, model: Model<Api>): Promise<Opened> {
		const def = this.definition;
		const { view } = pass;
		const tools = toolsFor(view, def, pass.tools, () => this.view ?? view);
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
	 * lane goes back to the entry that holds that position: a pass that
	 * failed or was cut after it leaves the provider input, and the record it
	 * held comes again in the delta. With no such entry, the lane goes back
	 * to the root, and the activation reads the whole view once.
	 */
	private async readBase(opened: Opened, pass: Pass): Promise<void> {
		if (pass.resume === undefined) return;
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
		this.activation.read({ after: 0, through });
	}

	/** The steers held while the pass prepared its prompt join the prompt. */
	private flush(): AgentMessage[] {
		const now = this.options.now();
		return this.held.splice(0).map((held) => steerMessage(held, now));
	}

	/** Queue a steer on the running lane. */
	private send(opened: Opened, held: Held): void {
		const queued = opened.lane
			.steer(steerMessage(held, this.options.now()), undefined, CONTEXT)
			.then((result) => getOrUndefined(result)?.entryId)
			.catch(() => undefined);
		this.steered.set(held.seq, queued);
	}

	/** One prompt of the lane, and what it means for the pass. */
	private async run(opened: Opened, prompt: AgentMessage[]): Promise<PassResult> {
		this.last = undefined;
		this.phase = 'running';
		const result = await opened.lane.prompt(prompt, CONTEXT);
		this.phase = 'idle';
		await this.settle(opened);
		// A cut pass is no failure, whatever the closed harness answers.
		if (this.stopped) return { failed: false };
		const outcome = passOutcome(result, this.last);
		if (outcome.failed) {
			const { cause, error } = outcome;
			return { failed: true, cause, message: error.message, error };
		}
		await this.remember(opened);
		return outcome.stop === undefined ? { failed: false } : { failed: false, stop: outcome.stop };
	}

	/**
	 * The steers no provider request held once the pass ended. Each leaves the
	 * lane queue, and the record holds it for the next delta.
	 */
	private async settle(opened: Opened): Promise<void> {
		const left = [...this.steered.values()];
		this.steered.clear();
		for (const queued of left) {
			const entryId = await queued;
			if (entryId !== undefined) await opened.lane.cancelQueued(entryId, CONTEXT).catch(noop);
		}
	}

	/**
	 * The record moved, but not in a way a model reads: a delta with no
	 * message in it. The core takes the view as read, and no pass starts.
	 */
	private async nothingNew(opened: Opened): Promise<PassResult> {
		await this.remember(opened);
		return { failed: false };
	}

	/**
	 * Write the position the session read through, for the activation that
	 * continues it. The session is a cache: when the write fails, the next
	 * activation reads the whole view, and this one runs on.
	 */
	private async remember(opened: Opened): Promise<void> {
		const through = this.activation.readThrough;
		await opened.lane.appendCustomEntry(READ, { through }, CONTEXT).catch(noop);
	}

	/** The provider messages of one request, and what they hold of the record. */
	private provide(messages: AgentMessage[]): Message[] {
		for (const seq of provided(messages, this.activation)) this.steered.delete(seq);
		return providerMessages(messages);
	}

	/** One harness event: its steps. The core raises the tool events from them. */
	private note(event: HarnessEvent): void {
		for (const step of this.steps.steps(event)) this.trace.record(step);
		if (event.type === 'message_end' && event.message.role === 'assistant') {
			this.last = event.message;
		}
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
