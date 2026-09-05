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
 * A deterministic streamFn. It routes on the model's id: every test agent is
 * defined as `scripted/<name>`, so the seat is the part after the slash and
 * no script ever reads the prompt to find out who it is. It counts calls per
 * agent, answers an abort with an aborted message, and turns a script that
 * throws into an error on the stream.
 */
export function scripted(script: Script): StreamFn {
	const calls = new Map<string, number>();
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const agent = model.id.slice(model.id.indexOf('/') + 1);
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

/** The assistant writes by calling its own tool. It has no say, because it says nothing. */
export const summarise = (text: string) => callTool('summarise', { text });

export const seat = (name: string) => callTool('seat', { name });

/** Everything the model was shown below the system prompt, as one string. */
export function contextText(context: Context): string {
	return context.messages
		.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
		.join('\n');
}

export const toolNames = (context: Context) => (context.tools ?? []).map((tool) => tool.name);
