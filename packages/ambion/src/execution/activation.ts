/**
 * The state of one activation that the driver owns.
 *
 * The driver opens one `ActivationState` for each activation, over the
 * opener of the seat. The state keeps the read position and the cut, runs
 * the refresh test, binds the room tools, renders the prompt of each pass,
 * raises the tool events from the steps, and raises the `error` event of a
 * failure once. The running activation runs its harness over what the state
 * hands it, and reports when the model consumed input.
 *
 * The state also records the `steer` step of every steered line. A line is
 * consumed when the pass in flight reads it in its view, or when the executor
 * reads its range through `read`. Any other line waits for the next delta, and
 * its step says so. The executor delivers a line when its harness can take
 * it, and records no `steer` step.
 */
import type { ActivationView } from '../protocol.ts';
import { sessionToResume } from '../protocol.ts';
import type { ActivationEvent, AgentDefinition, Seq, VendorSession } from '../types.ts';
import type {
	ActivationOpener,
	BoundTool,
	Pass,
	PassInput,
	PassRecord,
	PassResult,
	ReadRange,
	RunningActivation,
	StepSink,
} from './contract.ts';
import { failedPass } from './failure.ts';
import { Freshness } from './freshness.ts';
import { resolveReminders } from './reminders.ts';
import { renderActivation, renderDelta, renderScheduled, renderSystem } from './render.ts';
import { agentTools, type RoomToolBinding, roomTools } from './room-tools.ts';
import { ToolCalls } from './tool-calls.ts';

/** What the driver gives the state of one activation. */
export interface ActivationInput {
	readonly id: string;
	/** The room calls of the activation. The room tools commit and read through it. */
	readonly room: RoomToolBinding['room'];
	readonly definition: AgentDefinition;
	readonly emit: (event: ActivationEvent) => void;
	/** The sink of the activation. The driver owns it and closes it. */
	readonly trace: StepSink;
}

/** A line that landed while the activation worked. */
interface Steered {
	readonly after: Seq;
	readonly seq: Seq;
	readonly line: string;
}

export class ActivationState {
	readonly id: string;
	private readonly input: ActivationInput;
	private readonly freshness = new Freshness();
	private readonly controller = new AbortController();
	private readonly opened: RunningActivation;
	/** The sink the executor records into: the trace, read for the tool calls. */
	private readonly steps: StepSink;
	private tools: readonly BoundTool[] | undefined;
	/** The view of the latest pass. The tools of the definition read it. */
	private view: ActivationView | undefined;
	/** The pass in flight. Absent between passes. */
	private running: PassInput | undefined;
	/** The lines that landed before the first pass, in order. Absent once that pass starts. */
	private early: Steered[] | undefined = [];
	/** The lines the executor holds, by position, with the `after` of each. They have no step yet. */
	private readonly forwarded = new Map<Seq, Seq>();

	constructor(opener: ActivationOpener, input: ActivationInput) {
		this.id = input.id;
		this.input = input;
		const calls = new ToolCalls(input.id, (type, name) =>
			input.emit({ type, seat: input.definition.name, activation: input.id, name }),
		);
		const freshness = this.freshness;
		this.steps = calls.watching(input.trace);
		this.opened = opener({
			id: input.id,
			trace: this.steps,
			signal: this.controller.signal,
			get readThrough() {
				return freshness.readThrough;
			},
			read: (range) => this.consume(range),
			delivered: (call) => freshness.delivered(call),
			callId: (tool) => calls.callId(tool),
		});
	}

	/** The highest position the model consumed. The driver renews and releases with it. */
	get readThrough(): Seq {
		return this.freshness.readThrough;
	}

	/** Whether the activation was cut. A cut activation earns no further room call. */
	get isCut(): boolean {
		return this.controller.signal.aborted;
	}

	/** The vendor session to record with the release, when the executor reported one. */
	get session(): VendorSession | undefined {
		const id = this.opened.session;
		return id === undefined ? undefined : { kind: this.input.definition.executor.kind, id };
	}

	/** Whether the record stands past what the model read. A cut activation answers no. */
	shouldRefresh(lastSeq: Seq): boolean {
		return !this.isCut && lastSeq > this.readThrough;
	}

	/**
	 * A line landed while the activation worked. A cut activation takes none.
	 * A line that lands before the first pass waits for that pass.
	 */
	steer(after: Seq, seq: Seq, line: string): void {
		if (this.isCut) return;
		if (this.early === undefined) this.place({ after, seq, line });
		else this.early.push({ after, seq, line });
	}

	/** Cut the activation. The pass in flight ends, and the driver runs no other. */
	cut(): void {
		this.controller.abort();
	}

	/** Release what the session holds. A close that throws changes no outcome. */
	close(): void {
		try {
			this.opened.close?.();
		} catch {
			// The activation is over. A failed close changes no outcome.
		}
	}

	/** One pass over the record. A pass that throws is a failed pass: `failedPass` sets its cause. */
	async pass(input: PassInput): Promise<PassResult> {
		if (this.isCut) {
			this.dropEarly();
			return { failed: false };
		}
		const { seat } = input.view.spec;
		if (seat !== this.input.definition.name) {
			this.dropEarly();
			const message = `Activation names another seat: '${seat}'.`;
			return this.report({ failed: true, cause: 'transient', message });
		}
		this.view = input.view;
		this.running = input;
		let result: PassResult;
		try {
			const done = this.opened.pass(this.passOf(input));
			// The executor has started the pass: a line that waited can reach it now.
			this.placeEarly();
			result = await done;
		} catch (error) {
			result = failedPass(error);
		}
		this.running = undefined;
		this.dropEarly();
		this.expire();
		return this.report(result);
	}

	/** Raise the `error` event of a failed result, once, and give the result back. */
	report(result: PassResult): PassResult {
		if (result.failed) {
			this.input.emit({
				type: 'error',
				seat: this.input.definition.name,
				activation: this.id,
				error: result.error ?? new Error(result.message ?? 'The activation failed.'),
				...(result.cause === undefined ? {} : { cause: result.cause }),
			});
		}
		return result;
	}

	/**
	 * End the wait of the lines that landed before the first pass: no pass
	 * took them, so each waits for the next delta and records
	 * `consumed: false`, in order. The runner calls it when an activation
	 * ends with no pass, before the `end` step.
	 */
	dropEarly(): void {
		const early = this.early ?? [];
		this.early = undefined;
		for (const { seq } of early) this.stamp(seq, false);
	}

	/** The first pass runs: each line that waited for it now lands in that pass, in order. */
	private placeEarly(): void {
		const early = this.early ?? [];
		this.early = undefined;
		for (const steered of early) this.place(steered);
	}

	/**
	 * Decide a line by the moment it lands, and record its `steer` step when
	 * that moment decides it. A line the executor holds waits for its `read`.
	 */
	private place(steered: Steered): void {
		const { after, seq, line } = steered;
		if (this.running === undefined) this.stamp(seq, false);
		else if (seq <= this.running.view.through) this.stamp(seq, true);
		else if (this.opened.steer === undefined) this.stamp(seq, false);
		else this.forward(after, seq, line);
	}

	/**
	 * Hand a line to the executor. A `steer` that throws leaves the line to
	 * the next delta, unless the executor already read it.
	 */
	private forward(after: Seq, seq: Seq, line: string): void {
		this.forwarded.set(seq, after);
		try {
			this.opened.steer?.(after, seq, line);
		} catch {
			if (this.forwarded.delete(seq)) this.stamp(seq, false);
		}
	}

	/** The model consumed `range`. A range that equals a held line also consumed that line. */
	private consume(range: ReadRange): void {
		this.freshness.consumedRange(range);
		if (this.forwarded.get(range.through) !== range.after) return;
		this.forwarded.delete(range.through);
		this.stamp(range.through, true);
	}

	/** The pass ended. Each line the executor still holds waits for the next delta. */
	private expire(): void {
		const left = [...this.forwarded.keys()].sort((a, b) => a - b);
		this.forwarded.clear();
		for (const seq of left) this.stamp(seq, false);
	}

	private stamp(seq: Seq, consumed: boolean): void {
		this.input.trace.record({ type: 'steer', seq, consumed });
	}

	private passOf(input: PassInput): Pass {
		const { view } = input;
		const resumeId = sessionToResume(view, this.input.definition.executor.kind);
		return {
			...input,
			...renderSystem(view, this.input.definition),
			record: (after) => this.record(input, after),
			...(resumeId === undefined ? {} : { resumeId }),
			tools: this.toolsOf(view),
		};
	}

	/**
	 * The record a pass reads. A delta follows `after`, or the position a
	 * resumed session read through on the first pass of a respond activation.
	 * Any other pass reads the whole view. A pass with no new message counts
	 * the view read.
	 */
	private async record(input: PassInput, after: Seq | undefined): Promise<PassRecord | undefined> {
		const { view } = input;
		const from = input.kind === 'delta' ? input.after : after;
		const continues = input.kind === 'delta' || view.spec.purpose.kind === 'respond';
		const rendered =
			from !== undefined && continues ? await this.delta(input, from) : await this.whole(view);
		if (rendered === undefined) this.freshness.acknowledgeThrough(view.through);
		return rendered;
	}

	/**
	 * The messages after `from`. The first pass of an activation also reads
	 * the reminders of the bundles and the scheduled says, which the whole view
	 * holds. The reminders resolve only when a message is new.
	 */
	private async delta(input: PassInput, from: Seq): Promise<PassRecord | undefined> {
		const { view } = input;
		const delta = renderDelta(view, from);
		if (delta === undefined) return undefined;
		const first = input.kind === 'view';
		const reminders = first ? await resolveReminders(view, this.input.definition) : undefined;
		const pending = first ? renderScheduled(view) : undefined;
		const text = [reminders, pending, delta].filter((part) => part !== undefined).join('\n\n');
		return { text, range: { after: from, through: view.through } };
	}

	/** The whole view, with the reminders of the bundles. */
	private async whole(view: ActivationView): Promise<PassRecord> {
		const { definition } = this.input;
		const reminders = await resolveReminders(view, definition);
		const { context } = renderActivation(view, definition, reminders);
		return { text: context, range: { after: 0, through: view.through } };
	}

	/** The tools of the activation, bound on its first pass: the room tools, then the tools of the definition. */
	private toolsOf(view: ActivationView): readonly BoundTool[] {
		if (this.tools !== undefined) return this.tools;
		const freshness = this.freshness;
		const binding: RoomToolBinding = {
			id: this.id,
			room: this.input.room,
			get readThrough() {
				return freshness.readThrough;
			},
			acknowledgeThrough: (seq) => freshness.acknowledgeThrough(seq),
			resultExpected: (call, seq) => freshness.resultExpected(call, seq),
			reported: (compose, calls) => freshness.reported(compose, calls),
			ownEntry: (after, seq) => freshness.consumedRange({ after, through: seq }),
			cut: () => this.cut(),
		};
		const room = roomTools(view, binding);
		this.tools = [
			...room,
			...agentTools(
				view,
				this.input.definition,
				this.controller.signal,
				this.steps,
				() => this.view ?? view,
				room,
			),
		];
		return this.tools;
	}
}
