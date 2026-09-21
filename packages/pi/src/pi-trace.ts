/**
 * Pi events as trace steps.
 *
 * A stream that sends deltas gives a block as it grows: the deltas, then a
 * closing step. A stream that sends none gives the whole block at the end of
 * the message. Both reach the trace as the same block. The sink joins the
 * deltas.
 */

import type { Step } from '@ambionframework/ambion';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const isAssistant = (message: { role?: unknown }): message is AssistantMessage =>
	message.role === 'assistant';

/** The text of a tool result, for the `error` field of a failed call. */
function errorText(result: unknown): string {
	const content = (result as { content?: unknown } | undefined)?.content;
	if (!Array.isArray(content)) return 'The tool failed.';
	const text = content
		.map((part: { type?: unknown; text?: unknown }) => (part.type === 'text' ? part.text : ''))
		.join('');
	return text === '' ? 'The tool failed.' : text;
}

/** One assistant message as steps: its blocks the stream did not send, and its usage. */
function finished(message: AssistantMessage, streamed: ReadonlySet<number>): Step[] {
	const blocks = message.content.flatMap((block, index): Step[] => {
		if (streamed.has(index)) return [];
		if (block.type === 'text') return [{ type: 'text', text: block.text, final: true }];
		if (block.type === 'thinking' && block.redacted !== true)
			return [{ type: 'thinking', text: block.thinking, final: true }];
		return [];
	});
	const { usage } = message;
	const spent: Step = {
		type: 'usage',
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost.total,
	};
	return [...blocks, spent];
}

/** Turns one Pi event into the steps it stands for. One instance serves one activation. */
export class PiSteps {
	/** The content blocks of the current message that the stream already sent. */
	private streamed = new Set<number>();

	steps(event: AgentEvent): Step[] {
		switch (event.type) {
			case 'message_start':
				this.streamed = new Set();
				return [];
			case 'message_update':
				return this.update(event.assistantMessageEvent);
			case 'message_end':
				return isAssistant(event.message) ? finished(event.message, this.streamed) : [];
			case 'tool_execution_start':
				return [
					{ type: 'tool_call', call: event.toolCallId, name: event.toolName, input: event.args },
				];
			case 'tool_execution_end':
				return [
					{
						type: 'tool_result',
						call: event.toolCallId,
						output: event.result,
						...(event.isError ? { error: errorText(event.result) } : {}),
					},
				];
			default:
				return [];
		}
	}

	private update(event: {
		type: string;
		contentIndex?: number;
		delta?: string;
		content?: string;
	}): Step[] {
		const kind = event.type.startsWith('thinking') ? 'thinking' : 'text';
		if (event.contentIndex === undefined) return [];
		if (event.type === 'text_delta' || event.type === 'thinking_delta') {
			this.streamed.add(event.contentIndex);
			return [{ type: kind, text: event.delta ?? '', final: false }];
		}
		if (event.type === 'text_end' || event.type === 'thinking_end') {
			const sent = this.streamed.has(event.contentIndex);
			this.streamed.add(event.contentIndex);
			return [{ type: kind, text: sent ? '' : (event.content ?? ''), final: true }];
		}
		return [];
	}
}
