/** Task collaboration through the same provider and RPC paths as ordinary work. */
import { type Context, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

export function taskAnswer(agent: string, context: Context) {
	if (!agent.startsWith('task-')) return undefined;
	const text = context.messages
		.flatMap((message) =>
			typeof message.content === 'string'
				? [message.content]
				: message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
		)
		.join('\n');
	const inPass = context.messages.some((message) => message.role === 'toolResult');
	if (inPass) return fauxAssistantMessage('', { stopReason: 'stop' });
	if (agent === 'task-owner' && !text.includes('[Task ')) {
		return fauxAssistantMessage(
			[
				fauxToolCall('task', {
					text: 'Confirm the remote Task path.',
					agents: [text.includes('recover Task') ? 'task-slow' : 'task-worker'],
				}),
			],
			{ stopReason: 'toolUse' },
		);
	}
	const task = /Task (task-[\w-]+) \(open; pinned to this room\)/.exec(text)?.[1];
	if (agent !== 'task-owner' && task !== undefined) {
		return fauxAssistantMessage(
			[
				fauxToolCall('task_update', {
					task,
					status: 'succeeded',
					text: 'The remote Task completed.',
				}),
			],
			{ stopReason: 'toolUse' },
		);
	}
	return fauxAssistantMessage('', { stopReason: 'stop' });
}
