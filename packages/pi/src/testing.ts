/**
 * The deterministic tools for a room on Pi: a scripted `StreamFn` that
 * `piExecution({ stream })` takes, and the helpers that read what the model
 * was shown. A test that needs no Pi imports `scripted` from
 * `@ambionframework/ambion/testing`, which runs a script with no model.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';

/** One activation's answer: the model's message, given the context and which call this is. */
export type Script = (
	context: Context,
	agent: string,
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
		const agent = model.name;
		const call = (calls.get(agent) ?? 0) + 1;
		calls.set(agent, call);
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
			.then(() => script(context, agent, call))
			.catch((error: unknown) =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: String(error) }),
			)
			.then(finish);
		return stream;
	};
}

/**
 * Route a script by seat: one entry per agent that has lines, `quiet()` for the
 * rest. Keeping the seats apart is what keeps each one readable; a single
 * callback branching on `agent` buries the scenario in an if-chain.
 */
export const byAgent = (seats: Record<string, Script>): Script => {
	const table = new Map(Object.entries(seats));
	return (context, agent, call) => (table.get(agent) ?? (() => quiet()))(context, agent, call);
};

export const callTool = (tool: string, args: Record<string, unknown>) =>
	fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: 'toolUse' });

export const speak = (text: string, to?: string) => callTool('say', to ? { to, text } : { text });

export const quiet = (thought = 'nothing to add') =>
	fauxAssistantMessage(thought, { stopReason: 'stop' });

export const isClosing = (context: Context) =>
	context.systemPrompt?.includes('The exchange is over.') ?? false;

export const seat = (name: string) => callTool('seat', { name });

/** Everything the model was shown below the system prompt, as one string. */
export function contextText(context: Context): string {
	return context.messages
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n');
}

export const toolNames = (context: Context) => (context.tools ?? []).map((tool) => tool.name);

/** Every tool result the model has been shown so far, as text, oldest first. */
export function toolResultTexts(context: Context): string[] {
	return context.messages.flatMap((message) =>
		message.role === 'toolResult'
			? [message.content.map((c) => (c.type === 'text' ? c.text : '')).join('')]
			: [],
	);
}
