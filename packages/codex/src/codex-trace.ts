/**
 * Codex app-server notifications as trace steps.
 *
 * A seat has no native tools, so a thread holds four kinds of item. An
 * `agentMessage` or `reasoning` item arrives as deltas and then as a
 * completed item that carries the whole text. The steps hold the text as it
 * grows: one delta for each update, then a closing step. A `dynamicToolCall`
 * item becomes a `tool_call` step and a `tool_result` step. Each model
 * request reports its tokens, and each report becomes a `usage` step. A
 * diagnostic of Codex (`warning`, `configWarning`, `deprecationNotice`, or an
 * `error` that Codex retries) is a `notice`. The terminal failure of a pass
 * is no notice: the pass result carries it to the `end` step.
 *
 * An item of any other type is a native tool that the seat should not have.
 * A completed item of that type becomes a warning `notice` that names the
 * type, so a Codex release that adds a native tool shows in the trace.
 */
import type { Step, ToolContent, Usage } from '@ambionframework/ambion';
import {
	type DynamicToolOutput,
	type KnownItem,
	knownItem,
	type Notification,
	type NotificationParams,
	type ThreadItem,
	type ThreadOpened,
	type TokenBreakdown,
} from './protocol.ts';

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

/** A warning from a summary and the details that follow it, when there are any. */
function described(summary: string, details: string | null): Step {
	return warning(details === null || details === '' ? summary : `${summary} ${details}`);
}

/**
 * The tokens of one model request as ambion counts them. Codex counts the
 * tokens it read from the cache and the tokens it wrote to the cache inside
 * its input tokens, and reports no cost.
 */
export function usageOf(usage: TokenBreakdown): Usage {
	return {
		input: Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens),
		output: usage.outputTokens,
		cacheRead: usage.cachedInputTokens,
		cacheWrite: usage.cacheWriteInputTokens,
	};
}

/** The matches of a data URL: its media type and its base64 data. */
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/** One part of a tool result as the trace holds it: the shape of a `ToolContent`, with the image as it came when it is no data URL. */
function contentOf(part: DynamicToolOutput): ToolContent | { type: 'image'; url: string } {
	if (part.type === 'inputText') return { type: 'text', text: part.text };
	const found = DATA_URL.exec(part.imageUrl);
	return found?.[1] === undefined || found[2] === undefined
		? { type: 'image', url: part.imageUrl }
		: { type: 'image', mimeType: found[1], data: found[2] };
}

/** The text of a tool result, for the message of a failed call. */
function textOf(parts: readonly DynamicToolOutput[]): string {
	return parts.map((part) => (part.type === 'inputText' ? part.text : '')).join('');
}

/** The text that a failed call shows. A call that gave no text shows a plain message. */
function failureOf(item: Extract<KnownItem, { type: 'dynamicToolCall' }>): string {
	const text = textOf(item.contentItems ?? []);
	return text === '' ? 'The tool failed.' : text;
}

/** The name a step shows for a tool call. A namespace shows before the tool. */
function nameOf(item: Extract<KnownItem, { type: 'dynamicToolCall' }>): string {
	return item.namespace === null ? item.tool : `${item.namespace}__${item.tool}`;
}

/**
 * Maps notifications into the steps they stand for. One instance serves one
 * activation.
 *
 * Item ids are unique inside one pass. The id of a step is the scope, the
 * `turnId`, and the item id. A room tool takes that id as the key of its
 * commit, and the room keeps one message for each key.
 */
export class CodexSteps {
	/** What makes an id unique in the room: the id of the activation. */
	private readonly scope: string;
	/** How much of each text item the steps already hold, by step id. */
	private readonly sent = new Map<string, number>();
	/** The summary part that each reasoning item sent last, by step id. */
	private readonly parts = new Map<string, number>();
	/** Tool calls seen, by step id, so a completed item adds no second call step. */
	private readonly seen = new Set<string>();
	/** The texts of the config warnings the steps already hold. */
	private readonly warned = new Set<string>();

	constructor(scope: string) {
		this.scope = scope;
	}

	/** The id of the steps of an item. The server request that runs a tool names the same `turnId` and call. */
	idOf(turn: string, item: string): string {
		return `${this.scope}:${turn}:${item}`;
	}

	steps(note: Notification): Step[] {
		switch (note.method) {
			case 'item/agentMessage/delta':
				return this.grow(
					this.idOf(note.params.turnId, note.params.itemId),
					'text',
					note.params.delta,
				);
			case 'item/reasoning/summaryTextDelta':
				return this.summary(note.params);
			case 'item/started':
				return this.item(note.params, false);
			case 'item/completed':
				return this.item(note.params, true);
			case 'thread/tokenUsage/updated':
				return [{ type: 'usage', ...usageOf(note.params.tokenUsage.last) }];
			case 'error':
				return note.params.willRetry ? [warning(note.params.error.message)] : [];
			case 'warning':
				return this.once(warning(note.params.message));
			case 'configWarning':
				return this.once(described(note.params.summary, note.params.details));
			case 'deprecationNotice':
				return [described(note.params.summary, note.params.details)];
			default:
				return [];
		}
	}

	/** A warning once for each text. Codex reports the same warning again when it opens a thread. */
	private once(step: Step): Step[] {
		const text = step.type === 'notice' ? step.text : '';
		if (this.warned.has(text)) return [];
		this.warned.add(text);
		return [step];
	}

	/** A summary delta. A new part of the summary starts after a blank line. */
	private summary(params: NotificationParams['item/reasoning/summaryTextDelta']): Step[] {
		const id = this.idOf(params.turnId, params.itemId);
		const last = this.parts.get(id);
		this.parts.set(id, params.summaryIndex);
		const apart = last !== undefined && params.summaryIndex > last && (this.sent.get(id) ?? 0) > 0;
		return this.grow(id, 'thinking', apart ? `\n\n${params.delta}` : params.delta);
	}

	private item(
		params: { readonly turnId: string; readonly item: ThreadItem },
		done: boolean,
	): Step[] {
		const item = knownItem(params.item);
		if (item === undefined) {
			return done
				? [warning(`Codex reported a native ${params.item.type} item. A seat has no native tools.`)]
				: [];
		}
		const id = this.idOf(params.turnId, item.id);
		switch (item.type) {
			case 'agentMessage':
				return done ? this.close(id, 'text', item.text) : [];
			case 'reasoning':
				return done ? this.close(id, 'thinking', item.summary.join('\n\n')) : [];
			case 'dynamicToolCall':
				return this.tool(id, item, done);
			default:
				return [];
		}
	}

	/** A delta of a text item. */
	private grow(id: string, kind: 'text' | 'thinking', delta: string): Step[] {
		if (delta === '') return [];
		this.sent.set(id, (this.sent.get(id) ?? 0) + delta.length);
		return [{ type: kind, text: delta, final: false }];
	}

	/** The closing step of a text item, with the part of the text that no delta carried. */
	private close(id: string, kind: 'text' | 'thinking', whole: string): Step[] {
		const before = this.sent.get(id) ?? 0;
		this.sent.delete(id);
		this.parts.delete(id);
		if (before === 0) return whole === '' ? [] : [{ type: kind, text: whole, final: true }];
		const rest = whole.slice(before);
		return rest === ''
			? [{ type: kind, text: '', final: true }]
			: [
					{ type: kind, text: rest, final: false },
					{ type: kind, text: '', final: true },
				];
	}

	private tool(
		call: string,
		item: Extract<KnownItem, { type: 'dynamicToolCall' }>,
		done: boolean,
	): Step[] {
		const steps: Step[] = [];
		if (!this.seen.has(call)) {
			this.seen.add(call);
			steps.push({ type: 'tool_call', call, name: nameOf(item), input: item.arguments });
		}
		if (done) {
			const failed = item.status === 'failed' || item.success === false;
			steps.push({
				type: 'tool_result',
				call,
				output: (item.contentItems ?? []).map(contentOf),
				...(failed ? { error: failureOf(item) } : {}),
			});
		}
		return steps;
	}
}

/**
 * What a thread started with, as the `session` step. The step holds the
 * room tools by their plain names. `auth` is the type of the account, or
 * `none` when the server reports no account.
 */
export function sessionStep(
	opened: ThreadOpened,
	extra: {
		readonly auth: string | undefined;
		readonly tools: readonly string[];
		readonly servers: readonly { name: string; status: string }[];
	},
): Step {
	const policy =
		typeof opened.approvalPolicy === 'string'
			? opened.approvalPolicy
			: JSON.stringify(opened.approvalPolicy);
	return {
		type: 'session',
		name: 'codex',
		version: opened.thread.cliVersion,
		model: opened.model,
		cwd: opened.cwd,
		session: opened.thread.id,
		...(extra.auth === undefined ? {} : { auth: extra.auth }),
		permissionMode: `${policy}, ${opened.sandbox.type}`,
		tools: [...extra.tools],
		servers: extra.servers.map(({ name, status }) => ({ name, status })),
	};
}
