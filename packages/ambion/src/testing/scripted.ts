import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';

/** One activation's answer: the model's message, given the context, the seat, and which call this is for that seat. */
export type Script = (
	context: Context,
	seat: string,
	call: number,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 * A deterministic stream. It routes on the seat that the stub model names
 * (`model.name`), so no script reads the prompt to find out who it is. It
 * counts calls per seat, answers an abort with an aborted message, and turns
 * a script that throws into an error on the stream.
 */
export function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const seat = model.name;
		const call = (calls.get(seat) ?? 0) + 1;
		calls.set(seat, call);
		let finished = false;
		const finish = (message: AssistantMessage) => {
			if (finished) return;
			finished = true;
			if (message.stopReason === 'error' || message.stopReason === 'aborted') {
				stream.push({ type: 'error', reason: message.stopReason, error: message });
				return;
			}
			stream.push({ type: 'start', partial: message });
			stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
		};
		// A stream that ignores the signal keeps answering a cancelled activation for ever.
		const aborted = () =>
			finish(fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }));
		if (options?.signal?.aborted) {
			queueMicrotask(aborted);
			return stream;
		}
		options?.signal?.addEventListener('abort', aborted, { once: true });
		void Promise.resolve()
			.then(() => script(context, seat, call))
			.catch((error: unknown) =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }),
			)
			.then(finish);
		return stream;
	};
}

/** One script per seat. A seat with no entry answers `quiet()`. */
export const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (context, seat, call) => (table.get(seat) ?? (() => quiet()))(context, seat, call);
};

/** A message that calls one tool. Its stop reason is `toolUse`. */
export const callTool = (tool: string, args: Record<string, unknown>): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });

/** A message that calls `say`, to one seat or to the room. */
export const speak = (text: string, to?: string): AssistantMessage =>
	callTool('say', to ? { to, text } : { text });

/** A message with no tool call. Its stop reason is `stop`. */
export const quiet = (thought = 'nothing to add'): AssistantMessage =>
	fauxAssistantMessage(thought, { stopReason: 'stop' });

/**
 * True when the activation holds `say` alone: the closing activation. It
 * reads the tool set and never the prompt text.
 */
export const isClosing = (context: Context): boolean =>
	context.tools?.length === 1 && context.tools[0]?.name === 'say';
