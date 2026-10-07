/**
 * The events of a harness conversation as trace steps.
 *
 * A stream that sends deltas gives a block as it grows: the deltas, then a
 * closing step. A stream that sends none gives the whole block at the end of
 * the message. Both reach the trace as the same block, and the sink joins
 * the pieces. The assistant entry of each request gives one usage step.
 * Compaction spends tokens too, and no entry holds that spend. The
 * conversation reports it in the cumulative usage, and `flush` gives the
 * spend that no request accounts for as one more usage step.
 */
import type { Step } from '@ambionframework/ambion';
import type { AssistantMessage, Message, ToolCall, Usage } from '@earendil-works/pi-ai';
import type {
	AgentEvent,
	EntryRecord,
	MessageChange,
	UsageState,
} from '@earendil-works/pi-durable';

/**
 * What the session of an activation opened with. `model` is the model string
 * of the options, `provider/model-id`. `tools` holds the tools of the
 * harness by name. Pi keeps no working directory, credential source, or
 * permission mode, and it hosts no server.
 */
export function sessionStep(model: string, session: string, tools: readonly string[]): Step {
	return { type: 'session', name: 'pi', model, session, tools: [...tools], servers: [] };
}

const isAssistant = (message: Message | undefined): message is AssistantMessage =>
	message?.role === 'assistant';

/** The message of an entry. */
const messageOf = (entry: EntryRecord | undefined): Message | undefined => entry?.model?.[0];

/** The five numbers of one spend. */
interface Spend {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const empty = (): Spend => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

const count = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** The spend a usage record holds. */
function spendOf(usage: Partial<Usage> | undefined): Spend {
	return {
		input: count(usage?.input),
		output: count(usage?.output),
		cacheRead: count(usage?.cacheRead),
		cacheWrite: count(usage?.cacheWrite),
		cost: count(usage?.cost?.total),
	};
}

/** The spend of every model in the cumulative usage. */
export function totalOf(state: UsageState): Spend {
	const total = empty();
	for (const usage of Object.values(state.models)) {
		const spend = spendOf(usage as Partial<Usage>);
		total.input += spend.input;
		total.output += spend.output;
		total.cacheRead += spend.cacheRead;
		total.cacheWrite += spend.cacheWrite;
		total.cost += spend.cost;
	}
	return total;
}

const spent = (spend: Spend): Step => ({ type: 'usage', ...spend });

const nothing = (spend: Spend): boolean => Object.values(spend).every((value) => value === 0);

/** The text of a tool result message, for the `error` field of a failed call. */
function errorText(message: Message | undefined): string {
	if (message?.role !== 'toolResult') return 'The tool failed.';
	const text = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
	return text === '' ? 'The tool failed.' : text;
}

const textOf = (block: { type: string; text?: string; thinking?: string }): string =>
	(block.type === 'text' ? block.text : block.thinking) ?? '';

/** Turns the events of one conversation into the steps they stand for. One instance serves one activation. */
export class PiSteps {
	/** How many characters of each content block of the current message the stream sent. */
	private sent = new Map<number, number>();
	/** The tool calls of the latest assistant message, by id. */
	private calls = new Map<string, ToolCall>();
	/** The calls that have a `tool_call` step. */
	private started = new Set<string>();
	private readonly baseline: Spend;
	private latest: Spend;
	private accounted = empty();
	/** The last assistant message of the pass that runs. */
	last: AssistantMessage | undefined;

	/** `usage` is the cumulative usage of the conversation when the activation starts. */
	constructor(usage: UsageState) {
		this.baseline = totalOf(usage);
		this.latest = this.baseline;
	}

	steps(event: AgentEvent): Step[] {
		switch (event.type) {
			case 'message_start':
				if (isAssistant(event.message)) this.sent = new Map();
				return [];
			case 'message_update':
				return event.changes.flatMap((change) => this.change(change));
			case 'message_end':
				return this.ended(event.entry);
			case 'tool_execution_start':
				return this.start(event.toolCallId, event.toolName, event.args);
			case 'tool_execution_end':
				return this.finish(event.toolCallId, event.toolName, event.entry);
			case 'usage_changed':
				this.latest = totalOf(event.usage);
				return [];
			default:
				return [];
		}
	}

	/** A new pass starts: it has no assistant message yet. */
	forget(): void {
		this.last = undefined;
	}

	/**
	 * The spend that the conversation reports and no request accounts for:
	 * compaction. Call it once the events of the pass have arrived.
	 */
	flush(): Step[] {
		const rest: Spend = {
			input: this.latest.input - this.baseline.input - this.accounted.input,
			output: this.latest.output - this.baseline.output - this.accounted.output,
			cacheRead: this.latest.cacheRead - this.baseline.cacheRead - this.accounted.cacheRead,
			cacheWrite: this.latest.cacheWrite - this.baseline.cacheWrite - this.accounted.cacheWrite,
			cost: this.latest.cost - this.baseline.cost - this.accounted.cost,
		};
		if (nothing(rest) || Object.values(rest).some((value) => value < 0)) return [];
		this.accounted = {
			input: this.accounted.input + rest.input,
			output: this.accounted.output + rest.output,
			cacheRead: this.accounted.cacheRead + rest.cacheRead,
			cacheWrite: this.accounted.cacheWrite + rest.cacheWrite,
			cost: this.accounted.cost + rest.cost,
		};
		return [spent(rest)];
	}

	/** The part of a block that the stream has not sent. */
	private unsent(index: number, text: string): string {
		const sent = this.sent.get(index) ?? 0;
		this.sent.set(index, Math.max(sent, text.length));
		return text.slice(sent);
	}

	private change(change: MessageChange): Step[] {
		switch (change.type) {
			case 'text_start':
			case 'thinking_start':
			case 'block': {
				const { block } = change;
				if (block.type === 'text' || (block.type === 'thinking' && block.redacted !== true)) {
					return this.piece(change.contentIndex, block.type, textOf(block));
				}
				return [];
			}
			case 'text_delta':
			case 'thinking_delta': {
				const kind = change.type === 'text_delta' ? 'text' : 'thinking';
				this.sent.set(
					change.contentIndex,
					(this.sent.get(change.contentIndex) ?? 0) + change.delta.length,
				);
				return [{ type: kind, text: change.delta, final: false }];
			}
			default:
				return [];
		}
	}

	/** The unsent part of a block, when it has one. */
	private piece(index: number, type: 'text' | 'thinking', text: string): Step[] {
		const rest = this.unsent(index, text);
		return rest === '' ? [] : [{ type, text: rest, final: false }];
	}

	/** The end of an assistant message: the closing step of each block, and the spend. */
	private ended(entry: EntryRecord): Step[] {
		const message = messageOf(entry);
		if (!isAssistant(message)) return [];
		this.last = message;
		this.calls = new Map();
		const steps: Step[] = [];
		message.content.forEach((block, index) => {
			if (block.type === 'toolCall') this.calls.set(block.id, block);
			else if (block.type === 'text' || (block.type === 'thinking' && block.redacted !== true)) {
				steps.push({ type: block.type, text: this.unsent(index, textOf(block)), final: true });
			}
		});
		const spend = spendOf(message.usage);
		this.accounted = {
			input: this.accounted.input + spend.input,
			output: this.accounted.output + spend.output,
			cacheRead: this.accounted.cacheRead + spend.cacheRead,
			cacheWrite: this.accounted.cacheWrite + spend.cacheWrite,
			cost: this.accounted.cost + spend.cost,
		};
		steps.push(spent(spend));
		this.sent = new Map();
		return steps;
	}

	private start(call: string, name: string, input: unknown): Step[] {
		this.started.add(call);
		return [{ type: 'tool_call', call, name, input }];
	}

	/** The end of a tool call. A call that never started gives its `tool_call` step first. */
	private finish(call: string, name: string, entry: EntryRecord | undefined): Step[] {
		const steps = this.started.has(call)
			? []
			: this.start(call, name, this.calls.get(call)?.arguments);
		const message = messageOf(entry);
		const result = message?.role === 'toolResult' ? message : undefined;
		const failed = entry === undefined || result?.isError === true;
		steps.push({
			type: 'tool_result',
			call,
			output: {
				content: result?.content ?? [],
				...(result?.details === undefined ? {} : { details: result.details }),
			},
			...(failed ? { error: errorText(message) } : {}),
		});
		return steps;
	}
}
