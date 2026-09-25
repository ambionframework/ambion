import { expect, it } from 'vitest';
import { defineAssistant } from '../src/index.ts';

it('builds the default ordinary assistant definition', () => {
	const assistant = defineAssistant({ model: 'scripted/assistant' });

	expect(assistant).toMatchObject({
		name: 'assistant',
		executor: { model: 'scripted/assistant', tools: [] },
	});
	expect(assistant.identity).toContain('Seats and unseats specialists');
	expect(assistant.executor.instructions).toContain('Application instructions take precedence');
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
	expect(assistant.executor.instructions).toContain("Keep the room's membership fit");
	expect(assistant.executor.instructions).toContain('Application instructions:');
	expect(assistant.executor.instructions).toContain('Prefer small changes.');
});

it('passes tool bundles through the ordinary agent definition', () => {
	const assistant = defineAssistant({
		model: 'scripted/tools',
		tools: [],
		bundles: [{ tools: [], guidance: 'Use the workspace when evidence is needed.' }],
	});

	expect(assistant.executor.tools).toEqual([]);
	expect(assistant.executor.guidance).toContain('This is an ordinary activation.');
	expect(assistant.executor.guidance).toContain('Use the workspace when evidence is needed.');
});
