import type { Context, Message, TranscriptContext } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';

/**
 * The context a script reads. Pi carries the prompt and the tools in system
 * messages; the fold replays them into `systemPrompt` and `tools`, and keeps
 * the other messages.
 */
export function scriptContext(context: TranscriptContext): Context {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	return {
		...(systemPrompt ? { systemPrompt } : {}),
		tools: getCurrentTools(context.messages),
		messages: context.messages.filter((message: Message) => message.role !== 'system'),
	};
}
