import { createRuntime } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { taskStream } from './task-stream.ts';

describe('Task UI acceptance provider', () => {
	it.each(['succeeded', 'failed'] as const)(
		'reports %s after a terminal Task update',
		async (status) => {
			const control = taskStream();
			const runtime = createRuntime({ stream: control.stream });
			const model = await runtime.model('scripted/assistant', 'assistant');
			const respond = async (text: string) => {
				const stream = await control.stream(model, {
					systemPrompt: "You are 'assistant'.",
					messages: [{ role: 'user', content: text, timestamp: 0 }],
				});
				return stream.result();
			};
			await respond('[alice] Start a background task.');
			const result = await respond(`[alice] What is the task status?\nTask task-one is ${status}.`);
			expect(result.content).toContainEqual(
				expect.objectContaining({
					type: 'toolCall',
					name: 'say',
					arguments: { text: `The background Task ${status}.` },
				}),
			);
		},
	);
});
