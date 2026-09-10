/**
 * A scripted model call for the workerd tier: the product answers once per
 * activation, and every other seat stays quiet. It routes on the model id,
 * the way the runtime's own test support does.
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';

let answers = 0;

/** The product answers on the first call of every pass; a call after a tool result is quiet. */
function answer(agent: string, context: Context) {
	const inPass = context.messages.some((message) => message.role === 'toolResult');
	if (agent !== 'product' || inPass)
		return fauxAssistantMessage('nothing to add', { stopReason: 'stop' });
	answers += 1;
	return fauxAssistantMessage(
		[fauxToolCall('say', { text: answers === 1 ? 'The pour is Saturday.' : `Answer ${answers}.` })],
		{ stopReason: 'toolUse' },
	);
}

export const scripted: StreamFn = (model, context, options) => {
	const stream = createAssistantMessageEventStream();
	const message = answer(model.id.slice(model.id.indexOf('/') + 1), context);
	const finish = () => {
		stream.push({ type: 'start', partial: message });
		stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
	};
	if (options?.signal?.aborted) {
		queueMicrotask(() =>
			stream.push({
				type: 'error',
				reason: 'aborted',
				error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'aborted' }),
			}),
		);
		return stream;
	}
	queueMicrotask(finish);
	return stream;
};
