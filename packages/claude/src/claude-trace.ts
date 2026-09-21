/**
 * Claude Agent SDK messages as trace steps.
 *
 * With partial messages on, the SDK sends a text or thinking block as
 * `stream_event` deltas, then a closing `content_block_stop`. The
 * assistant message that follows holds the same block. The steps hold the
 * block once: the deltas, then a closing step. A block the stream did not
 * send arrives whole from the assistant message. The sink joins the deltas.
 */
import type { Step, Usage } from '@ambionframework/ambion';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/** The prefix the SDK gives a tool of the in-process room server. */
export const ROOM_SERVER = 'ambion';
const ROOM_PREFIX = `mcp__${ROOM_SERVER}__`;

/** The name a step and an event show: the tool without the server prefix. */
export function plainName(tool: string): string {
	return tool.startsWith(ROOM_PREFIX) ? tool.slice(ROOM_PREFIX.length) : tool;
}

interface Block {
	readonly type: string;
	readonly text?: string;
	readonly thinking?: string;
	readonly id?: string;
	readonly name?: string;
	readonly input?: unknown;
	readonly tool_use_id?: string;
	readonly content?: unknown;
	readonly is_error?: boolean;
}

/** The part of a raw stream event that the steps read. */
interface StreamEvent {
	readonly type: string;
	readonly index?: number;
	readonly message?: { readonly id?: string };
	readonly content_block?: { readonly type?: string };
	readonly delta?: { readonly type?: string; readonly text?: string; readonly thinking?: string };
}

/** The blocks of a message body, or none when the body is a plain string. */
function blocksOf(content: unknown): Block[] {
	return Array.isArray(content) ? (content as Block[]) : [];
}

/** The text of a tool result body. */
function textOf(content: unknown): string {
	if (typeof content === 'string') return content;
	return blocksOf(content)
		.map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
		.join('');
}

/** What a tool result block says went wrong, or nothing when the call worked. */
function errorOf(block: Block): string | undefined {
	if (block.is_error !== true) return undefined;
	const text = textOf(block.content);
	return text === '' ? 'The tool failed.' : text;
}

/** The tokens every model of a result used, summed. */
function tokensOf(result: SDKResultMessage): Usage {
	const models = Object.values(result.modelUsage ?? {});
	const sum = (read: (model: (typeof models)[number]) => number) =>
		models.reduce((total, model) => total + read(model), 0);
	return {
		input: sum((model) => model.inputTokens),
		output: sum((model) => model.outputTokens),
		cacheRead: sum((model) => model.cacheReadInputTokens),
		cacheWrite: sum((model) => model.cacheCreationInputTokens),
		cost: result.total_cost_usd ?? 0,
	};
}

/** What `total` holds beyond `before`, or nothing when it holds no more. */
function beyond(total: Usage, before: Usage | undefined): Usage | undefined {
	const step: Usage = {
		input: total.input - (before?.input ?? 0),
		output: total.output - (before?.output ?? 0),
		cacheRead: total.cacheRead - (before?.cacheRead ?? 0),
		cacheWrite: total.cacheWrite - (before?.cacheWrite ?? 0),
		cost: (total.cost ?? 0) - (before?.cost ?? 0),
	};
	const tokens = step.input + step.output + step.cacheRead + step.cacheWrite;
	return tokens > 0 || step.cost !== 0 ? step : undefined;
}

/** The usage a result message adds beyond `before`, and the running totals it carries. */
export function usageOf(
	result: SDKResultMessage,
	before: Usage | undefined,
): { readonly total: Usage; readonly step: Usage | undefined } {
	const total = tokensOf(result);
	return { total, step: beyond(total, before) };
}

/** The steps of a block the assistant message holds whole. */
function whole(block: Block): Step[] {
	if (block.type === 'text') return [{ type: 'text', text: block.text ?? '', final: true }];
	if (block.type === 'thinking')
		return [{ type: 'thinking', text: block.thinking ?? '', final: true }];
	return [];
}

/** A delta of a streamed block, as a step. */
function deltaStep(kind: 'text' | 'thinking', delta: StreamEvent['delta']): Step[] {
	const text = kind === 'text' ? delta?.text : delta?.thinking;
	return text === undefined ? [] : [{ type: kind, text, final: false }];
}

/** Turns SDK messages into the steps they stand for. One instance serves one activation. */
export class ClaudeSteps {
	/** The messages whose text and thinking blocks the stream already sent. */
	private readonly streamed = new Set<string>();
	/** The kind of each open block of the streaming message, by index. */
	private readonly open = new Map<number, 'text' | 'thinking'>();
	/** Tool calls seen, by id, so an assistant message resent adds none. */
	private readonly seen = new Set<string>();
	/** Tool call ids the model made and no handler has claimed yet. */
	private readonly unclaimed: { id: string; name: string }[] = [];
	private cumulative: Usage | undefined;

	steps(message: SDKMessage): Step[] {
		switch (message.type) {
			case 'stream_event':
				return message.parent_tool_use_id === null ? this.stream(message.event as StreamEvent) : [];
			case 'assistant':
				return message.parent_tool_use_id === null ? this.assistant(message) : [];
			case 'user':
				return message.parent_tool_use_id === null ? this.results(message.message.content) : [];
			case 'result':
				return this.spent(message);
			default:
				return [];
		}
	}

	/** The id the model gave the next call of this tool, or nothing when none is waiting. */
	claim(tool: string): string | undefined {
		const at = this.unclaimed.findIndex((call) => plainName(call.name) === tool);
		if (at < 0) return undefined;
		return this.unclaimed.splice(at, 1)[0]?.id;
	}

	private stream(event: StreamEvent): Step[] {
		if (event.type === 'message_start') return this.begin(event.message?.id ?? '');
		if (event.index === undefined) return [];
		if (event.type === 'content_block_start')
			return this.opened(event.index, event.content_block?.type);
		const kind = this.open.get(event.index);
		if (kind === undefined) return [];
		if (event.type === 'content_block_stop') return this.closed(event.index, kind);
		return event.type === 'content_block_delta' ? deltaStep(kind, event.delta) : [];
	}

	private begin(id: string): Step[] {
		this.streamed.add(id);
		this.open.clear();
		return [];
	}

	private opened(index: number, kind: string | undefined): Step[] {
		if (kind === 'text' || kind === 'thinking') this.open.set(index, kind);
		return [];
	}

	private closed(index: number, kind: 'text' | 'thinking'): Step[] {
		this.open.delete(index);
		return [{ type: kind, text: '', final: true }];
	}

	private assistant(message: Extract<SDKMessage, { type: 'assistant' }>): Step[] {
		const streamed = this.streamed.has(message.message.id);
		return blocksOf(message.message.content).flatMap((block): Step[] => {
			if (block.type === 'tool_use') return this.called(block);
			return streamed ? [] : whole(block);
		});
	}

	/** A tool call the model made. A call the assistant message repeats adds nothing. */
	private called(block: Block): Step[] {
		if (block.id === undefined || this.seen.has(block.id)) return [];
		this.seen.add(block.id);
		this.unclaimed.push({ id: block.id, name: block.name ?? '' });
		return [
			{ type: 'tool_call', call: block.id, name: plainName(block.name ?? ''), input: block.input },
		];
	}

	private results(content: unknown): Step[] {
		return blocksOf(content).flatMap((block): Step[] => {
			if (block.type !== 'tool_result' || block.tool_use_id === undefined) return [];
			const error = errorOf(block);
			return [
				{
					type: 'tool_result',
					call: block.tool_use_id,
					output: block.content,
					...(error === undefined ? {} : { error }),
				},
			];
		});
	}

	/** Every result carries the running totals of the session. The step holds what this result added. */
	private spent(result: SDKResultMessage): Step[] {
		const { total, step } = usageOf(result, this.cumulative);
		this.cumulative = total;
		return step === undefined ? [] : [{ type: 'usage', ...step }];
	}
}
