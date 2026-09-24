/**
 * Pi harness events as trace steps.
 *
 * A stream that sends deltas gives a block as it grows: the deltas, then a
 * closing step. A stream that sends none gives the whole block at the end of
 * the message. Both reach the trace as the same block. The sink joins the
 * deltas. The harness reports the spend of each provider request as one
 * `usage` event, and each becomes one usage step.
 */

import type { Step } from '@ambionframework/ambion';
import type { HarnessEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';

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

/** The blocks of one assistant message that the stream did not send. */
function finished(message: AssistantMessage, streamed: ReadonlySet<number>): Step[] {
	return message.content.flatMap((block, index): Step[] => {
		if (streamed.has(index)) return [];
		if (block.type === 'text') return [{ type: 'text', text: block.text, final: true }];
		if (block.type === 'thinking' && block.redacted !== true)
			return [{ type: 'thinking', text: block.thinking, final: true }];
		return [];
	});
}

type Of<T extends HarnessEvent['type']> = Extract<HarnessEvent, { type: T }>;

/** The spend of one provider request. */
function spent(event: Of<'usage'>): Step {
	const { usage } = event.row;
	return {
		type: 'usage',
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		cost: usage.cost.total,
	};
}

function toolResult(event: Of<'tool_end'>): Step {
	return {
		type: 'tool_result',
		call: event.toolCallId,
		output: event.result,
		...(event.isError ? { error: errorText(event.result) } : {}),
	};
}

/** Turns one harness event into the steps it stands for. One instance serves one activation. */
export class PiSteps {
	/** The content blocks of the current message that the stream already sent. */
	private streamed = new Set<number>();

	steps(event: HarnessEvent): Step[] {
		switch (event.type) {
			case 'message_start':
				if (isAssistant(event.message)) this.streamed = new Set();
				return [];
			case 'message_update':
				return this.update(event.event);
			case 'message_end':
				return isAssistant(event.message) ? finished(event.message, this.streamed) : [];
			case 'usage':
				return [spent(event)];
			case 'tool_start':
				return [
					{ type: 'tool_call', call: event.toolCallId, name: event.toolName, input: event.args },
				];
			case 'tool_end':
				return [toolResult(event)];
			default:
				return [];
		}
	}

	private update(event: AssistantMessageEvent): Step[] {
		if (!('contentIndex' in event)) return [];
		const kind = event.type.startsWith('thinking') ? 'thinking' : 'text';
		if (event.type === 'text_delta' || event.type === 'thinking_delta') {
			this.streamed.add(event.contentIndex);
			return [{ type: kind, text: event.delta, final: false }];
		}
		if (event.type === 'text_end' || event.type === 'thinking_end') {
			const sent = this.streamed.has(event.contentIndex);
			this.streamed.add(event.contentIndex);
			return [{ type: kind, text: sent ? '' : event.content, final: true }];
		}
		return [];
	}
}
