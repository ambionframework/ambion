import { claude } from '@ambionframework/claude';
import { codex } from '@ambionframework/codex';
import { pi } from '@ambionframework/pi';
import { expect, it } from 'vitest';
import { type AssistantParts, defineAssistant } from '../src/index.ts';

const onPi = (parts: AssistantParts) => pi({ ...parts, model: 'scripted/assistant' });

it('builds the default ordinary assistant definition', () => {
	const assistant = defineAssistant({ executor: onPi });

	expect(assistant).toMatchObject({
		name: 'assistant',
		executor: { model: 'scripted/assistant', tools: [] },
	});
	expect(assistant.identity).toContain('Seats and unseats specialists');
	expect(assistant.executor.instructions).toContain('Application instructions take precedence');
});

it('keeps application instructions after and alongside maintained defaults', () => {
	const assistant = defineAssistant({
		executor: onPi,
		name: 'guide',
		identity: 'A local guide.',
		instructions: 'Prefer small changes.',
	});

	expect(assistant.name).toBe('guide');
	expect(assistant.identity).toBe('A local guide.');
	expect(assistant.executor.instructions).toContain("Keep the room's seating fit");
	expect(assistant.executor.instructions).toContain('Application instructions:');
	expect(assistant.executor.instructions).toContain('Prefer small changes.');
});

it('passes tool bundles through the ordinary agent definition', () => {
	const assistant = defineAssistant({
		executor: onPi,
		tools: [],
		bundles: [{ tools: [], guidance: 'Use the workspace when evidence is needed.' }],
	});

	expect(assistant.executor.tools).toEqual([]);
	expect(assistant.executor.guidance).toContain('This is a respond activation.');
	expect(assistant.executor.guidance).toContain(
		'The presence of the person who asked does not change the work.',
	);
	expect(assistant.executor.guidance).toContain('Use the workspace when evidence is needed.');
});

it.each([
	['pi', (parts: AssistantParts) => pi({ ...parts, model: 'scripted/assistant' })],
	['codex', (parts: AssistantParts) => codex({ ...parts, model: 'gpt-6-luna' })],
	['claude', (parts: AssistantParts) => claude({ ...parts, model: 'claude-sonnet-5' })],
] as const)(
	'gives the %s executor the same instructions, tools, guidance, and reminders',
	(kind, executor) => {
		const remind = () => 'Check the stock list.';
		const assistant = defineAssistant({
			executor,
			instructions: 'Prefer small changes.',
			bundles: [{ tools: [], guidance: 'Use the workspace when evidence is needed.', remind }],
		});

		expect(assistant.executor.kind).toBe(kind);
		expect(assistant.executor.instructions).toContain('Prefer small changes.');
		expect(assistant.executor.tools).toEqual([]);
		expect(assistant.executor.guidance).toContain('This is a respond activation.');
		expect(assistant.executor.guidance).toContain('Use the workspace when evidence is needed.');
		expect(assistant.executor.reminders).toEqual([remind]);
	},
);
