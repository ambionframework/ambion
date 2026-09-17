import { expect, it } from 'vitest';
import { defineAssistant } from '../src/index.ts';

it('builds the default ordinary assistant definition', () => {
	const assistant = defineAssistant({ model: 'scripted/assistant' });

	expect(assistant).toMatchObject({
		name: 'assistant',
		model: 'scripted/assistant',
		tools: [],
	});
	expect(assistant.identity).toContain('room');
	expect(assistant.instructions).toContain('Application instructions take precedence');
});

it('keeps application instructions after and alongside maintained defaults', () => {
	const assistant = defineAssistant({
		model: 'scripted/custom',
		name: 'guide',
		identity: 'A local guide.',
		instructions: 'Prefer small changes.',
	});

	expect(assistant.name).toBe('guide');
	expect(assistant.identity).toBe('A local guide.');
	expect(assistant.instructions).toContain('Help the room advance');
	expect(assistant.instructions).toContain('Application instructions:');
	expect(assistant.instructions).toContain('Prefer small changes.');
});

it('passes tool bundles through the ordinary agent definition', () => {
	const assistant = defineAssistant({
		model: 'scripted/tools',
		tools: [],
		bundles: [{ tools: [], guidance: 'Use the workspace when evidence is needed.' }],
	});

	expect(assistant.tools).toEqual([]);
	expect(assistant.guidance).toContain('This is an ordinary activation.');
	expect(assistant.guidance).toContain('Use the workspace when evidence is needed.');
});

it('keeps ordinary guidance out of closing work and preserves overrides in both', async () => {
	const prompts: { closing: boolean; system: string }[] = [];
	const assistant = defineAssistant({
		model: 'scripted/assistant',
		instructions: 'Use the application response format.',
	});
	const runtime = createRuntime({
		stream: (_model, context) => {
			const closing = context.tools?.length === 1;
			prompts.push({ closing, system: context.systemPrompt ?? '' });
			const stream = createAssistantMessageEventStream();
			const message = closing
				? fauxAssistantMessage([fauxToolCall('say', { text: 'Ready.' })], { stopReason: 'toolUse' })
				: fauxAssistantMessage('', { stopReason: 'stop' });
			queueMicrotask(() => {
				stream.push({ type: 'start', partial: message });
				stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
			});
			return stream;
		},
	});
	const room = await startRoom({ name: 'assistant-guidance', assistant, runtime });
	try {
		const exchange = await (
			await room.visit(defineHuman({ name: 'priya', identity: 'Owner.' }))
		).send({ text: 'Check readiness.' });
		expect((await exchange.waitForSummary())?.text).toBe('Ready.');
		expect(prompts).toHaveLength(2);
		for (const prompt of prompts) {
			expect(prompt.system.includes('This is an ordinary activation.')).toBe(!prompt.closing);
			expect(prompt.system).toContain('Use the application response format.');
		}
	} finally {
		await room.stop();
	}
});

import { createRuntime, defineHuman, startRoom } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
