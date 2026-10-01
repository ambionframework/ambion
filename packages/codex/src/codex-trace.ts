/**
 * Codex thread events as trace steps.
 *
 * A seat has no native tools, so Codex reports four kinds of item. Codex
 * reports an item as it starts, as it changes, and as it completes. An
 * `agent_message` or `reasoning` item carries the whole text so far, so the
 * steps hold the growth of the text: one delta for each update, then a
 * closing step. An `mcp_tool_call` item becomes a `tool_call` and a
 * `tool_result`. A diagnostic of Codex (an `error` item or an `error` event)
 * is a `notice`. The terminal failure of a turn is no notice: the pass result
 * carries it to the `end` step.
 *
 * An item of any other type is a native tool that the seat should not have.
 * A completed item of that type becomes a warning `notice` that names the
 * type, so a Codex release that adds a native tool shows in the trace.
 */
import type { Step, Usage } from '@ambionframework/ambion';
import { ROOM_SERVER } from '@ambionframework/ambion/hosting';
import type { McpToolCallItem, ThreadEvent, ThreadItem } from '@openai/codex-sdk';

/** The name a step shows for a tool call. A tool of the room server shows without its server. */
function nameOf(item: McpToolCallItem): string {
	return item.server === ROOM_SERVER ? item.tool : `${item.server}__${item.tool}`;
}

/** What a finished tool call hands back, and what it says went wrong. */
function outcomeOf(item: McpToolCallItem): { output: unknown; error?: string } {
	if (item.status === 'failed') {
		return { output: item.result?.content, error: item.error?.message ?? 'The tool failed.' };
	}
	return { output: item.result?.content };
}

/** The longest diagnostic text a notice keeps. A provider error body can be large. */
export const NOTICE_CHARS = 2000;

/** A diagnostic of Codex as a step. A long text keeps its start and a note of its length. */
function warning(text: string): Step {
	const kept =
		text.length <= NOTICE_CHARS
			? text
			: `${text.slice(0, NOTICE_CHARS)} [${text.length - NOTICE_CHARS} more characters]`;
	return { type: 'notice', level: 'warning', text: kept };
}

/**
 * The tokens of a turn as ambion counts them. Codex counts the tokens it
 * read from the cache and the tokens it wrote to the cache inside its input
 * tokens, and reports no cost. The recorded turns show it: a first turn
 * reports 12387 input tokens with 12384 of them written to the cache.
 */
export function usageOf(usage: {
	input_tokens: number;
	cached_input_tokens: number;
	cache_write_input_tokens?: number;
	output_tokens: number;
}): Usage {
	return {
		input: Math.max(
			0,
			usage.input_tokens - usage.cached_input_tokens - (usage.cache_write_input_tokens ?? 0),
		),
		output: usage.output_tokens,
		cacheRead: usage.cached_input_tokens,
		cacheWrite: usage.cache_write_input_tokens ?? 0,
	};
}

/**
 * Turns thread events into the steps they stand for. One instance serves one
 * activation.
 *
 * A real `codex` numbers the items of each turn from `item_0`, so an item id
 * is unique only inside one turn. The id of a step is the scope, the number
 * of the turn, and the item id. A room tool takes that id as the key of its
 * commit, and the room keeps one message for each key.
 */
export class CodexSteps {
	/** What makes an id unique in the room: the id of the activation. */
	private readonly scope: string;
	/** The number of the turn in flight. It moves on each `turn.started`. */
	private turn = 0;
	/** How much of each text item the steps already hold, by step id. */
	private readonly sent = new Map<string, number>();
	/** Tool calls seen, by step id, so a completed item adds no second call step. */
	private readonly seen = new Set<string>();

	constructor(scope: string) {
		this.scope = scope;
	}

	/** The id of the steps of an item in the turn in flight. */
	private idOf(item: ThreadItem): string {
		return `${this.scope}:${this.turn}:${item.id}`;
	}

	steps(event: ThreadEvent): Step[] {
		switch (event.type) {
			case 'turn.started':
				this.turn += 1;
				return [];
			case 'item.started':
			case 'item.updated':
				return this.item(event.item, false);
			case 'item.completed':
				return this.item(event.item, true);
			case 'turn.completed':
				return [{ type: 'usage', ...usageOf(event.usage) }];
			case 'error':
				return [warning(event.message)];
			default:
				return [];
		}
	}

	private item(item: ThreadItem, done: boolean): Step[] {
		if (item.type === 'agent_message') return this.grown(this.idOf(item), 'text', item.text, done);
		if (item.type === 'reasoning') return this.grown(this.idOf(item), 'thinking', item.text, done);
		if (item.type === 'error') return done ? [warning(item.message)] : [];
		if (item.type === 'mcp_tool_call') return this.tool(item, done);
		return done
			? [warning(`Codex reported a native ${item.type} item. A seat has no native tools.`)]
			: [];
	}

	/** The growth of a text item since the last event, and a closing step when it completes. */
	private grown(id: string, kind: 'text' | 'thinking', whole: string, done: boolean): Step[] {
		const before = this.sent.get(id) ?? 0;
		const delta = whole.slice(before);
		this.sent.set(id, whole.length);
		if (!done) return delta === '' ? [] : [{ type: kind, text: delta, final: false }];
		this.sent.delete(id);
		if (before === 0) return [{ type: kind, text: whole, final: true }];
		return delta === ''
			? [{ type: kind, text: '', final: true }]
			: [
					{ type: kind, text: delta, final: false },
					{ type: kind, text: '', final: true },
				];
	}

	private tool(item: McpToolCallItem, done: boolean): Step[] {
		const steps: Step[] = [];
		const call = this.idOf(item);
		if (!this.seen.has(call)) {
			this.seen.add(call);
			steps.push({ type: 'tool_call', call, name: nameOf(item), input: item.arguments });
		}
		if (done) {
			const { output, error } = outcomeOf(item);
			steps.push({
				type: 'tool_result',
				call,
				output,
				...(error === undefined ? {} : { error }),
			});
		}
		return steps;
	}
}
