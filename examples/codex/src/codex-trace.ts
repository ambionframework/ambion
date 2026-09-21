/**
 * Codex thread events as trace steps.
 *
 * Codex reports an item as it starts, as it changes, and as it completes.
 * An `agent_message` or `reasoning` item carries the whole text so far, so
 * the steps hold the growth of the text: one delta for each update, then a
 * closing step. A tool item becomes a `tool_call` and a `tool_result`. An
 * item that Codex reports only at its end gives both steps at once.
 */
import type { Step, Usage } from '@ambionframework/ambion';
import { SAY, SEAT, UNSEAT } from '@ambionframework/ambion/hosting';
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';

/** The name of the MCP server that holds the room tools. */
export const ROOM_SERVER = 'ambion';

const ROOM_TOOLS: readonly string[] = [SAY.name, SEAT.name, UNSEAT.name];

/** Whether a step names a tool the room reports as its own event. */
export function isRoomTool(name: string): boolean {
	return ROOM_TOOLS.includes(name);
}

/** The name a step shows for an item. A tool of the room server shows without its server. */
function nameOf(item: ThreadItem): string {
	switch (item.type) {
		case 'mcp_tool_call':
			return item.server === ROOM_SERVER ? item.tool : `${item.server}__${item.tool}`;
		case 'command_execution':
			return 'command';
		case 'file_change':
			return 'file_change';
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
		default:
			return { output: undefined };
	}
}

/** The item types that run as a tool. */
function isTool(item: ThreadItem): boolean {
	return ['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(item.type);
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
 * The tokens of a turn as ambion counts them. Codex counts cached tokens
 * inside its input tokens, and reports no cost.
 */
export function usageOf(usage: {
	input_tokens: number;
	cached_input_tokens: number;
	cache_write_input_tokens?: number;
	output_tokens: number;
}): Usage {
	return {
		input: Math.max(0, usage.input_tokens - usage.cached_input_tokens),
		output: usage.output_tokens,
		cacheRead: usage.cached_input_tokens,
		cacheWrite: usage.cache_write_input_tokens ?? 0,
	};
}

/** Turns thread events into the steps they stand for. One instance serves one activation. */
export class CodexSteps {
	/** How much of each text item the steps already hold, by item id. */
	private readonly sent = new Map<string, number>();
	/** Tool calls seen, by id, so a completed item adds no second call step. */
	private readonly seen = new Set<string>();
	/** Room tool call ids that no handler has claimed yet. */
	private readonly unclaimed: { id: string; name: string }[] = [];

	steps(event: ThreadEvent): Step[] {
		switch (event.type) {
			case 'item.started':
			case 'item.updated':
				return this.item(event.item, false);
			case 'item.completed':
				return this.item(event.item, true);
			case 'turn.completed':
				return [{ type: 'usage', ...usageOf(event.usage) }];
			default:
				return [];
		}
	}

	/** The id the model gave the next call of this room tool, or nothing when none is waiting. */
	claim(tool: string): string | undefined {
		const at = this.unclaimed.findIndex((call) => call.name === tool);
		if (at < 0) return undefined;
		return this.unclaimed.splice(at, 1)[0]?.id;
	}

	private item(item: ThreadItem, done: boolean): Step[] {
		if (item.type === 'agent_message') return this.grown(item.id, 'text', item.text, done);
		if (item.type === 'reasoning') return this.grown(item.id, 'thinking', item.text, done);
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
		if (!this.seen.has(item.id)) {
			this.seen.add(item.id);
			const name = nameOf(item);
			if (item.type === 'mcp_tool_call' && item.server === ROOM_SERVER) {
				this.unclaimed.push({ id: item.id, name });
			}
			steps.push({ type: 'tool_call', call: item.id, name, input: inputOf(item) });
		}
		if (done) {
			const { output, error } = outcomeOf(item);
			steps.push({
				type: 'tool_result',
				call: item.id,
				output,
				...(error === undefined ? {} : { error }),
			});
		}
		return steps;
	}
}
