/**
 * The tool calls of one activation, read from the steps its executor records.
 *
 * A `tool_call` step names a call and its tool, and a `tool_result` step with
 * the same call id ends it. The core pairs the two and raises the tool
 * events, so no executor raises one. A harness that hosts a tool where it
 * cannot see the id of a call takes the id from the steps.
 */
import { DISMISS, SAY, SCHEDULE, SEAT, UNSEAT } from '../define.ts';
import type { Step } from '../types.ts';
import type { StepSink } from './contract.ts';

/**
 * The room tools whose call commits an entry to the record. The `message`
 * event of the entry reports the call, so the call raises no tool event.
 * `recall` commits nothing, and it raises tool events.
 */
const COMMITS: ReadonlySet<string> = new Set([
	SAY.name,
	SCHEDULE.name,
	SEAT.name,
	UNSEAT.name,
	DISMISS.name,
]);

type ToolEvent = 'tool_call' | 'tool_result';

export class ToolCalls {
	private readonly activation: string;
	private readonly raise: (type: ToolEvent, tool: string) => void;
	/** The tool of each call in flight, by call id. */
	private readonly named = new Map<string, string>();
	/**
	 * The calls in flight that no hosted tool took yet, in the order the steps
	 * named them. A result ends a call, so the result step drops its entry.
	 */
	private readonly unclaimed: { readonly call: string; readonly name: string }[] = [];
	private serial = 0;

	constructor(activation: string, raise: (type: ToolEvent, tool: string) => void) {
		this.activation = activation;
		this.raise = raise;
	}

	/** A sink that records into `trace` and reads each step for the tool calls. */
	watching(trace: StepSink): StepSink {
		return {
			record: (step) => {
				trace.record(step);
				this.note(step);
			},
		};
	}

	/** The id of the next call of `tool` that the steps named, or a fresh id. */
	callId(tool: string): string {
		const claimed = this.take((call) => call.name === tool);
		return claimed?.call ?? `${this.activation}:${tool}:${this.serial++}`;
	}

	/** Remove and give back the oldest unclaimed call that `matches` accepts. */
	private take(
		matches: (call: { readonly call: string; readonly name: string }) => boolean,
	): { readonly call: string; readonly name: string } | undefined {
		const at = this.unclaimed.findIndex(matches);
		return at < 0 ? undefined : this.unclaimed.splice(at, 1)[0];
	}

	private note(step: Step): void {
		if (step.type === 'tool_call') {
			this.named.set(step.call, step.name);
			this.unclaimed.push({ call: step.call, name: step.name });
			if (!COMMITS.has(step.name)) this.raise('tool_call', step.name);
		} else if (step.type === 'tool_result') {
			const name = this.named.get(step.call);
			this.named.delete(step.call);
			this.take((call) => call.call === step.call);
			if (name !== undefined && !COMMITS.has(name)) this.raise('tool_result', name);
		}
	}
}
