/**
 * The Pi opener: it opens one running activation, which takes each pass the
 * driver hands it until the activation stops.
 *
 * A pi-durable `Harness` owns the model loop, the session, its persistence
 * and its compaction. The driver's contract is pass in and result out, so
 * the first pass of an activation opens one harness over the seat's session
 * and its root conversation. Each pass submits one input to the conversation
 * and resolves when the submission settles.
 *
 * - **Freshness.** The core keeps `readThrough`. Each range of the record
 *   goes into the session as an `ambion.record` entry that carries its
 *   positions, and its text reaches the model in the input of the pass. The
 *   hook that runs before each request reads the entries of the context, and
 *   tells the core each range and each tool result that the request holds.
 * - **Steer.** A line that lands during a pass is a write to the
 *   conversation. The harness places it after the tool results of the
 *   running request, and the next request holds it. It counts as consumed
 *   when a provider request holds it. A line that lands before the pass
 *   starts joins the input. The core records the `steer` step
 *   ([`executors.md`](../../../docs/executors.md)), and a line the pass does
 *   not read waits for the next delta.
 * - **Cut.** The signal of the activation aborts the conversation. `close`
 *   closes the harness and the session, and the driver calls it when the
 *   activation is over.
 * - **Exchange continuity.** A session carries the id of the activation
 *   that began it, and the release records that id. The activation reopens
 *   the session that `spec.resume` names, which the room hands back inside
 *   one exchange, and sends the record beyond the position the session read
 *   through. A session the store cannot open starts fresh. Work that a lost
 *   process left in the session ends before the activation submits, and a
 *   pass that did not answer leaves the context at the next pass.
 *
 * **Three spans, and only two are ours.** Pi has a *turn*, which is one
 * request to a provider and the tools it calls, and a *run*, which is one
 * input and the turns inside it. A pass is one Pi run. An activation is
 * wider than both: it is one or more passes, because a message landing
 * mid-activation starts another pass over the record as it now stands. The
 * word for what a room does to a seat is `activation`
 * ([`agent.md`](../../../docs/agent.md), Execution boundary), and the lease
 * entries and the trace of each one carry that word.
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
import { BACKGROUND_CONTEXT as CONTEXT } from '@earendil-works/chord/context';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import type { AgentEvent, Storage, Submission } from '@earendil-works/pi-durable';
import { compactionOf, modelOf, thinkingOf } from './define.ts';
import { passOutcome } from './failure.ts';
import { type Range, recordDraft, steerDraft } from './freshness.ts';
import { type OpenHarness, openHarness, shutdown } from './harness.ts';
import { streamModels } from './models.ts';
import { PiSteps, sessionStep } from './pi-trace.ts';
import type { ExecutionServices } from './services.ts';
import type { PiSessions, SessionScope } from './sessions.ts';
import { toolsFor } from './tools.ts';
import { rewind } from './transcript.ts';

/** What builds a Pi opener for one seat: its definition, and the room's services. */
export interface PiOpenerOptions extends ExecutionServices {
	readonly definition: AgentDefinition;
	/** The room's clock. The session stamps every steered line with it. */
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

/** A steered line held until its pass submits its input. */
interface Held {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

/** A steered line: its range, and its write to the conversation. */
interface Steered {
	readonly range: Range;
	readonly written: Promise<Submission | undefined>;
}

/** One range of the record that a pass reads, and its text. */
interface Part {
	readonly range: Range;
	readonly text: string;
}

/** The harness of an activation, its session id, its tool names, and the steps of its events. */
interface Opened extends OpenHarness {
	readonly id: string;
	readonly tools: readonly string[];
	readonly steps: PiSteps;
}

const noop = () => {};

/** A steered line as a part of the pass that reads it. */
const steerPart = (held: Held): Part => ({
	range: { after: held.after, through: held.seq, steer: true },
	text: held.line,
});

/** One activation, from the moment the room wakes a seat until it stops. */
class Activation implements RunningActivation {
	private readonly activation: ExecutorActivation;
	private readonly definition: AgentDefinition;
	private readonly options: PiOpenerOptions;
	private readonly seat: Seat;
	/** The harness of this activation. The first pass opens it, and `close` closes it. */
	private opened: Opened | undefined;
	/** The id of the session this activation opened. */
	private sessionId: string | undefined;
	/** The position a continued session read through, when the activation continues one. */
	private base: Seq | undefined;
	private passes = 0;
	private systemPrompt = '';
	/** The view of the running pass. The tools read the room and exchange from it. */
	private view: ActivationView | undefined;
	/**
	 * Where the pass stands: `starting` prepares its input, `running` waits
	 * on its input, and `idle` is any other time. A steer takes a different
	 * path in each.
	 */
	private phase: 'idle' | 'starting' | 'running' = 'idle';
	/** The steers that landed while a pass prepared its input. */
	private held: Held[] = [];
	/** The steered lines that no provider request holds yet, by position. */
	private readonly steered = new Map<Seq, Steered>();
	/** The ranges of the running pass that no provider request holds yet. */
	private pending: Range[] = [];
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
	 * A line landed while a pass runs. A running pass takes it as a write to
	 * the conversation. A pass that prepares its input adds the line to it.
	 * After the pass, the line waits for the record: the next delta has it.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.phase === 'starting') this.held.push({ after, seq, line });
		else if (this.phase === 'running' && this.opened !== undefined) {
			this.send(this.opened, { after, seq, line });
		}
	}

	/** The activation was cut: abort the conversation. The pass in flight ends. */
	private abort(): void {
		this.stopped = true;
		this.cutNow();
		this.opened?.root.abort(CONTEXT).catch(noop);
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
			// The retry must not continue a session that broke. It starts fresh.
			this.sessionId = undefined;
			// A local fault, such as a lost room call or an unknown model. `failedPass` sets the cause.
			return failedPass(error);
		} finally {
			this.phase = 'idle';
			// A line the pass never read waits for the next delta.
			this.held = [];
		}
	}

	/**
	 * Open the harness, and submit what the pass has to read. A pass with
	 * nothing new submits nothing.
	 */
	private async runPass(pass: Pass): Promise<PassResult> {
		const opened = await this.prepare(pass);
		if (opened === undefined || this.stopped) return { failed: false };
		// A pass that did not answer leaves its entries in the context.
		if (this.passes++ > 0) await rewind(opened.storage, opened.root);
		const record = await pass.record(this.base);
		const parts = [
			...(record === undefined ? [] : [{ range: record.range, text: record.text }]),
			...this.held.splice(0).map(steerPart),
		];
		return parts.length === 0 ? { failed: false } : this.run(opened, parts);
	}

	/**
	 * The harness of this activation. The first pass resolves the definition's
	 * model, opens the session, and holds the tools of the pass. Later passes
	 * keep it.
	 */
	private async prepare(pass: Pass): Promise<Opened | undefined> {
		if (this.opened !== undefined) return this.opened;
		const model = await this.options.model(modelOf(this.definition.executor), this.definition.name);
		if (this.stopped) return undefined;
		return this.hold(await this.openSession(pass, model));
	}

	/**
	 * Take the harness as this activation's, unless the activation closed while
	 * it opened. The `session` step comes before any event of the harness.
	 */
	private hold(opened: Opened): Opened | undefined {
		this.sessionId = opened.id;
		this.opened = opened;
		if (this.closed) {
			this.release();
			return undefined;
		}
		this.trace.record(sessionStep(modelOf(this.definition.executor), opened.id, opened.tools));
		if (opened.base !== undefined) {
			this.base = opened.base;
			this.activation.read({ after: 0, through: opened.base });
		}
		return opened;
	}

	/**
	 * A harness over the session `spec.resume` names, or over a fresh session
	 * under this activation's id. A session that does not open, or that the
	 * harness cannot attach to, closes, and a fresh session takes its place.
	 */
	private async openSession(pass: Pass, model: Model<Api>): Promise<Opened> {
		const scope = scopeOf(pass.view, this.definition);
		const storage = await this.resumed(scope, pass.resumeId);
		const { resumeId } = pass;
		if (storage !== undefined && resumeId !== undefined) {
			const opened = await this.attach(storage, resumeId, pass, model, true).catch(
				(error: unknown) => this.fellBack('Pi session not resumed', resumeId, error),
			);
			if (opened !== undefined) return opened;
		}
		const created = await this.seat.sessions.create(scope, this.activation.id);
		if (created.fallback !== undefined) {
			this.fellBack('Pi session kept in memory', created.id, created.fallback);
		}
		return this.attach(created.storage, created.id, pass, model, false);
	}

	/** The session `spec.resume` names, once the activation that held it closed it. */
	private async resumed(
		scope: SessionScope,
		resume: string | undefined,
	): Promise<Storage | undefined> {
		if (resume === undefined) return undefined;
		// An ended activation may still close the session, and a session opens once.
		// A cut ends the wait.
		await Promise.race([this.seat.closing.get(resume), this.cut]);
		return this.seat.sessions
			.open(scope, resume)
			.catch((error: unknown) => this.fellBack('Pi session not opened', resume, error));
	}

	/** Say in the trace that a session fell back, and keep the cause. The activation runs on. */
	private fellBack(text: string, session: string, cause: unknown): undefined {
		const reason = cause instanceof Error ? cause.message : String(cause);
		this.trace.record({ type: 'notice', level: 'warning', text, data: { session, reason } });
		return undefined;
	}

	/** A harness over the storage, with the tools of this activation. A failed attach closes the storage. */
	private async attach(
		storage: Storage,
		id: string,
		pass: Pass,
		model: Model<Api>,
		resume: boolean,
	): Promise<Opened> {
		const def = this.definition;
		const { view } = pass;
		try {
			const tools = toolsFor(view, def, pass.tools, this.trace, () => this.view ?? view);
			const open = await openHarness({
				storage,
				models: streamModels(model, this.options.stream),
				model,
				tools,
				systemPrompt: () => this.systemPrompt,
				compaction: compactionOf(def.executor),
				thinking: thinkingOf(def.executor),
				now: this.options.now,
				resume,
				beforeRequest: (messages) => this.provide(messages),
			});
			const steps = new PiSteps(open.events.snapshot.usage);
			open.events.start(async (events) => this.note(steps, events));
			return { ...open, id, tools: tools.map((tool) => tool.name), steps };
		} catch (error) {
			await storage.close(CONTEXT).catch(noop);
			throw error;
		}
	}

	/** Queue a steered line on the running conversation. */
	private send(opened: Opened, held: Held): void {
		const { range, text } = steerPart(held);
		const written = opened.root
			.submit({ type: 'write', entry: steerDraft(range, text, this.options.now()) }, CONTEXT)
			.catch(() => undefined);
		this.steered.set(held.seq, { range, written });
	}

	/** One input to the conversation, and what it means for the pass. */
	private async run(opened: Opened, parts: readonly Part[]): Promise<PassResult> {
		opened.steps.forget();
		const { root } = opened;
		for (const part of parts)
			await root.submit({ type: 'write', entry: recordDraft(part.range) }, CONTEXT);
		if (this.stopped) return { failed: false };
		this.pending = parts.map((part) => part.range);
		const input = await root.submit(
			{ type: 'input', content: parts.map((part) => part.text).join('\n\n'), whenBusy: 'reject' },
			CONTEXT,
		);
		this.phase = 'running';
		// A steer that landed while the input went in takes the same path as every later one.
		for (const held of this.held.splice(0)) this.send(opened, held);
		if (this.stopped) await root.abort(CONTEXT);
		const settled = await opened.trap.race(input.wait(CONTEXT)).catch(async (error: unknown) => {
			// The harness goes on from a fault it reports. No tool and no request follows a failed pass.
			await root.abort(CONTEXT).catch(noop);
			throw error;
		});
		await this.drain();
		// A cut pass is no failure, whatever the closed harness answers.
		if (this.stopped) return { failed: false };
		for (const step of opened.steps.flush()) this.trace.record(step);
		if (settled.status === 'unanswered' && settled.reason === 'faulted') this.sessionId = undefined;
		const outcome = passOutcome(settled, opened.steps.last);
		if (outcome.failed) {
			const { cause, error } = outcome;
			return { failed: true, cause, message: error.message, error };
		}
		return outcome.stop === undefined ? { failed: false } : { failed: false, stop: outcome.stop };
	}

	/**
	 * The pass ended. The events of its last messages arrive, and each steer
	 * that no provider request held leaves the queue. The record holds the
	 * line for the next delta. A steer that landed at the last boundary is in
	 * the session already: the next rewind omits it.
	 */
	private async drain(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 0));
		const left = [...this.steered.values()];
		this.steered.clear();
		this.pending = [];
		for (const { written } of left) await (await written)?.abort(CONTEXT).catch(noop);
	}

	/**
	 * What one provider request holds of the record: the ranges of the pass
	 * that the input carries, each steered line that the harness placed, and
	 * each tool result. A line the harness placed at the last boundary has
	 * no request after it, and stays unread.
	 */
	private async provide(messages: readonly Message[]): Promise<void> {
		for (const range of this.pending.splice(0)) this.activation.read(range);
		for (const [seq, { range, written }] of [...this.steered]) {
			const submission = await written;
			if (submission === undefined || (await submission.status(CONTEXT)).status !== 'done')
				continue;
			this.activation.read(range);
			this.steered.delete(seq);
		}
		for (const message of messages) {
			if (message.role === 'toolResult') this.activation.delivered(message.toolCallId);
		}
	}

	/** The events of the conversation: their steps. The core raises the tool events from them. */
	private note(steps: PiSteps, events: readonly AgentEvent[]): void {
		for (const event of events) {
			for (const step of steps.steps(event)) this.trace.record(step);
		}
	}

	/** Close the harness and its session, and let the seat's next activation wait for it. */
	private release(): void {
		const opened = this.opened;
		if (opened === undefined) return;
		this.opened = undefined;
		this.closing(opened.id, shutdown(opened));
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
}

/** The room and seat a session belongs to. */
function scopeOf(view: ActivationView, definition: AgentDefinition): SessionScope {
	return { room: view.context.name, seat: definition.name };
}
