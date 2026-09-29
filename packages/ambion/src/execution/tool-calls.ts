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
import type { TraceSink } from './trace.ts';

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

type ToolEvent = 'tool_execution_start' | 'tool_execution_end';

export class ToolCalls {
	private readonly activation: string;
	private readonly raise: (type: ToolEvent, tool: string) => void;
	/** The tool of each call in flight, by call id. */
	private readonly named = new Map<string, string>();
	/** The calls that no hosted tool took yet, in the order the steps named them. */
	private readonly unclaimed: { readonly call: string; readonly name: string }[] = [];
	private serial = 0;

	constructor(activation: string, raise: (type: ToolEvent, tool: string) => void) {
		this.activation = activation;
		this.raise = raise;
	}

	/** A sink that records into `trace` and reads each step for the tool calls. */
	watching(trace: TraceSink): TraceSink {
		return {
			startPass: (input, through) => trace.startPass(input, through),
			record: (step) => {
				trace.record(step);
				this.note(step);
			},
			usage: () => trace.usage(),
			close: () => trace.close(),
		};
	}

	/** The id of the next call of `tool` that the steps named, or a fresh id. */
	callId(tool: string): string {
		const at = this.unclaimed.findIndex((call) => call.name === tool);
		const claimed = at < 0 ? undefined : this.unclaimed.splice(at, 1)[0];
		return claimed?.call ?? `${this.activation}:${tool}:${this.serial++}`;
	}

	private note(step: Step): void {
		if (step.type === 'tool_call') {
			this.named.set(step.call, step.name);
			this.unclaimed.push({ call: step.call, name: step.name });
			if (!COMMITS.has(step.name)) this.raise('tool_execution_start', step.name);
		} else if (step.type === 'tool_result') {
			const name = this.named.get(step.call);
			this.named.delete(step.call);
			if (name !== undefined && !COMMITS.has(name)) this.raise('tool_execution_end', name);
		}
	}
}
