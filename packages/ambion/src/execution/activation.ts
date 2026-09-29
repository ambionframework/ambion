/**
 * The state of one activation that the core owns.
 *
 * The driver opens one `ActivationState` for each activation, over the
 * executor of the seat. The state keeps the read position and the cut, runs
 * the refresh test, binds the room tools, renders the prompt of each pass,
 * raises the tool events from the steps, and raises the `error` event of a
 * failure once. The executor session runs its harness over what the state
 * hands it, and reports when the model consumed input.
 */
import type { ActivationView } from '../protocol.ts';
import { sessionToResume } from '../protocol.ts';
import type { AgentDefinition, ExecutionEvent, HarnessSession, Seq } from '../types.ts';
import type {
	Executor,
	ExecutorSession,
	Pass,
	PassInput,
	PassRecord,
	PassResult,
} from './executor.ts';
import { Freshness } from './freshness.ts';
import { resolveReminders } from './reminders.ts';
import { renderActivation, renderDelta, renderPending, renderSystem } from './render.ts';
import { agentTools, type RoomTool, type RoomToolBinding, roomTools } from './room-tools.ts';
import { ToolCalls } from './tool-calls.ts';
import type { StepSink } from './trace.ts';

/** What the driver gives the state of one activation. */
export interface ActivationInput {
	readonly id: string;
	/** The room calls of the activation. The room tools commit and read through it. */
	readonly room: RoomToolBinding['room'];
	readonly definition: AgentDefinition;
	readonly emit: (event: ExecutionEvent) => void;
	/** The sink of the activation. The driver owns it and closes it. */
	readonly trace: StepSink;
}

/** The tools of one activation: the room tools and the tools of the definition. */
interface Tools {
	readonly room: readonly RoomTool[];
	readonly agent: readonly RoomTool[];
}

/** A failure of the activation that a retry can pass. */
const transient = (message: string): PassResult => ({
	failed: true,
	cause: 'transient',
	message,
});

/** A thrown error as a transient failure that carries it. */
function failure(thrown: unknown): PassResult {
	const error = thrown instanceof Error ? thrown : new Error(String(thrown));
	return { ...transient(error.message), error };
}

export class ActivationState {
	readonly id: string;
	private readonly input: ActivationInput;
	private readonly harness: string | undefined;
	private readonly freshness = new Freshness();
	private readonly cut = new AbortController();
	private readonly executor: ExecutorSession;
	private tools: Tools | undefined;
	/** The view of the latest pass. The tools of the definition read it. */
	private view: ActivationView | undefined;

	constructor(executor: Executor, input: ActivationInput) {
		this.id = input.id;
		this.input = input;
		this.harness = executor.harness;
		const calls = new ToolCalls(input.id, (type, toolName) =>
			input.emit({ type, agent: input.definition.name, activation: input.id, toolName }),
		);
		const freshness = this.freshness;
		this.executor = executor.open({
			id: input.id,
			trace: calls.watching(input.trace),
			signal: this.cut.signal,
			get readThrough() {
				return freshness.readThrough;
			},
			read: (range) => freshness.consumedRange(range),
			delivered: (call) => freshness.delivered(call),
			callId: (tool) => calls.callId(tool),
		});
	}

	/** The highest position the model consumed. The driver renews and releases with it. */
	get readThrough(): Seq {
		return this.freshness.readThrough;
	}

	/** Whether the activation was cut. A cut activation earns no further room call. */
	get cancelled(): boolean {
		return this.cut.signal.aborted;
	}

	/** The harness session to record with the release, when the executor reported one. */
	get session(): HarnessSession | undefined {
		const id = this.executor.session;
		return this.harness === undefined || id === undefined
			? undefined
			: { harness: this.harness, id };
	}

	/** Whether the record stands past what the model read. A cut activation answers no. */
	shouldRefresh(lastSeq: Seq): boolean {
		return !this.cancelled && lastSeq > this.readThrough;
	}

	/** A line landed while the activation worked. A cut activation takes none. */
	steer(after: Seq, seq: Seq, line: string): void {
		if (!this.cancelled) this.executor.steer?.(after, seq, line);
	}

	/** Cut the activation. The pass in flight ends, and the driver runs no other. */
	cancel(): void {
		this.cut.abort();
	}

	/** Release what the session holds. A close that throws changes no outcome. */
	close(): void {
		try {
			this.executor.close?.();
		} catch {
			// The activation is over. A failed close changes no outcome.
		}
	}

	/** One pass over the record. A pass that throws is a transient failure. */
	async pass(input: PassInput): Promise<PassResult> {
		if (this.cancelled) return { failed: false };
		const { seat } = input.view.spec;
		if (seat !== this.input.definition.name) {
			return this.report(transient(`Activation names another seat: '${seat}'.`));
		}
		this.view = input.view;
		let result: PassResult;
		try {
			result = await this.executor.pass(this.passOf(input));
		} catch (error) {
			result = failure(error);
		}
		return this.report(result);
	}

	/** Raise the `error` event of a failed result, once, and give the result back. */
	report(result: PassResult): PassResult {
		if (result.failed) {
			this.input.emit({
				type: 'error',
				agent: this.input.definition.name,
				activation: this.id,
				error: result.error ?? new Error(result.message ?? 'The activation failed.'),
				...(result.cause === undefined ? {} : { cause: result.cause }),
			});
		}
		return result;
	}

	private passOf(input: PassInput): Pass {
		const { view } = input;
		const tools = this.toolsOf(view);
		const resume = this.harness === undefined ? undefined : sessionToResume(view, this.harness);
		return {
			...input,
			...renderSystem(view, this.input.definition),
			record: (after) => this.record(input, after),
			...(resume === undefined ? {} : { resume }),
			tools: tools.room,
			agentTools: tools.agent,
		};
	}

	/**
	 * The record a pass reads. A delta follows `since`, or the position a
	 * resumed session read through on the first pass of a respond activation.
	 * Any other pass reads the whole view. A pass with no new message counts
	 * the view read.
	 */
	private async record(input: PassInput, after: Seq | undefined): Promise<PassRecord | undefined> {
		const { view } = input;
		const from = input.kind === 'delta' ? input.since : after;
		const continues = input.kind === 'delta' || view.spec.purpose.kind === 'respond';
		const rendered =
			from !== undefined && continues ? await this.delta(input, from) : await this.whole(view);
		if (rendered === undefined) this.freshness.acknowledgeThrough(view.through);
		return rendered;
	}

	/**
	 * The messages after `from`. The first pass of an activation also reads
	 * the reminders of the bundles and the pending says, which the whole view
	 * holds. The reminders resolve only when a message is new.
	 */
	private async delta(input: PassInput, from: Seq): Promise<PassRecord | undefined> {
		const { view } = input;
		const delta = renderDelta(view, from);
		if (delta === undefined) return undefined;
		const first = input.kind === 'view';
		const reminders = first ? await resolveReminders(view, this.input.definition) : undefined;
		const pending = first ? renderPending(view) : undefined;
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

	/** The tools of the activation, bound on its first pass. */
	private toolsOf(view: ActivationView): Tools {
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
			abort: () => this.cancel(),
		};
		this.tools = {
			room: roomTools(view, binding, this.executor.roomTools),
			agent: agentTools(view, this.input.definition, this.cut.signal, () => this.view ?? view),
		};
		return this.tools;
	}
}
