/**
 * Codex thread events as trace steps.
 *
 * Codex reports an item as it starts, as it changes, and as it completes.
 * An `agent_message` or `reasoning` item carries the whole text so far, so
 * the steps hold the growth of the text: one delta for each update, then a
 * closing step. A tool item becomes a `tool_call` and a `tool_result`. An
 * item that Codex reports only at its end gives both steps at once. The plan
 * of the agent (`todo_list`) is the tool `update_plan`. A diagnostic of Codex
 * (an `error` item or an `error` event) is a `notice`. The terminal failure of
 * a turn is no notice: the pass result carries it to the `end` step.
 */
import type { Step, Usage } from '@ambionframework/ambion';
import { ROOM_SERVER } from '@ambionframework/ambion/hosting';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';

/** The name a step shows for an item. A tool of the room server shows without its server. */
function nameOf(item: ThreadItem): string {
	switch (item.type) {
		case 'mcp_tool_call':
			return item.server === ROOM_SERVER ? item.tool : `${item.server}__${item.tool}`;
		case 'command_execution':
			return 'command';
		case 'file_change':
			return 'file_change';
		case 'todo_list':
			return 'update_plan';
		default:
			return item.type;
	}
}

/** The input a tool call step shows. */
function inputOf(item: ThreadItem): unknown {
	switch (item.type) {
		case 'mcp_tool_call':
			return item.arguments;
		case 'command_execution':
			return { command: item.command };
		case 'file_change':
			return { changes: item.changes };
		case 'web_search':
			return { query: item.query };
		case 'todo_list':
			return { items: item.items };
		default:
			return undefined;
	}
}

/** What a finished tool item hands back, and what it says went wrong. */
function outcomeOf(item: ThreadItem): { output: unknown; error?: string } {
	switch (item.type) {
		case 'mcp_tool_call': {
			if (item.status === 'failed') {
				return { output: item.result?.content, error: item.error?.message ?? 'The tool failed.' };
			}
			return { output: item.result?.content };
		}
		case 'command_execution': {
			const output = { output: item.aggregated_output, exitCode: item.exit_code };
			return item.status === 'failed'
				? { output, error: `The command failed with exit code ${item.exit_code ?? 'unknown'}.` }
				: { output };
		}
		case 'file_change':
			return item.status === 'failed'
				? { output: item.changes, error: 'The patch failed.' }
				: { output: item.changes };
		case 'todo_list':
			return { output: item.items };
		default:
			return { output: undefined };
	}
}

/** The item types that run as a tool. */
function isTool(item: ThreadItem): boolean {
	return ['mcp_tool_call', 'command_execution', 'file_change', 'web_search', 'todo_list'].includes(
		item.type,
	);
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

/** The paths a completed patch changed. A failed patch changed none. */
export function changedPaths(event: ThreadEvent): string[] {
	if (event.type !== 'item.completed') return [];
	const { item } = event;
	return item.type === 'file_change' && item.status === 'completed'
		? item.changes.map((change) => change.path)
		: [];
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
		return isTool(item) ? this.tool(item, done) : [];
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

	private tool(item: ThreadItem, done: boolean): Step[] {
		const steps: Step[] = [];
		const call = this.idOf(item);
		if (!this.seen.has(call)) {
			this.seen.add(call);
			steps.push({ type: 'tool_call', call, name: nameOf(item), input: inputOf(item) });
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
