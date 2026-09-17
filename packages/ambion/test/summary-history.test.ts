import { expect, it } from 'vitest';
import { defineAgent, defineHuman, startRoom } from '../src/index.ts';
import {
	byAgent,
	contextText,
	isClosing,
	quiet,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';

const priya = defineHuman({ name: 'priya', identity: 'Owns the request.' });

it('gives closing work prior summaries while keeping the new range local', async () => {
	let productAnswered = false;
	let followUpOrdinaryActivations = 0;
	let followUpClosingContext: string | undefined;
	const product = defineAgent({
		name: 'product',
		identity: 'Knows the approved count.',
		instructions: 'Answer the approved-count question once.',
		model: 'scripted/product',
	});
	const assistant = defineAgent({
		name: 'assistant',
		identity: 'Writes summaries for the person.',
		instructions: 'Keep ordinary activations quiet and answer the current request in closing work.',
		model: 'scripted/assistant',
	});
	const session = await startRoom({
		name: `summary-history-${crypto.randomUUID()}`,
		goal: 'Keep the approved facts available across exchanges.',
		summary: assistant.name,
		agents: [product, assistant],
		seats: { product: 'broadcast', assistant: 'broadcast' },
		streamFn: scripted(
			byAgent({
				product: (context) => {
					if (!productAnswered && contextText(context).includes('What is the approved count?')) {
						productAnswered = true;
						return speak('Mira owns the project. The approved count is 8.');
					}
					return quiet();
				},
				assistant: (context) => {
					const text = contextText(context);
					if (!isClosing(context)) {
						if (text.includes('Who owns the project?')) followUpOrdinaryActivations += 1;
						return quiet();
					}
					if (text.includes('Who owns the project?')) {
						followUpClosingContext = text;
						return summarise('Mira owns the project.');
					}
					if (text.includes('What is the approved count?'))
						return summarise(
							'Mira owns the project. The approved count is 8. Historical note: the office opens Tuesday.',
						);
					return quiet();
				},
			}),
		),
	});
	try {
		const visit = await session.visit(priya);
		const first = await visit.send({ text: 'What is the approved count?' });
		const firstSummary = await first.waitForSummary();
		if (firstSummary === undefined) throw new Error('The first exchange has no summary.');

		const second = await visit.send({ text: 'Who owns the project?' });
		const secondMessages = await second.waitForClose();
		const secondSummary = await second.waitForSummary();
		if (secondSummary === undefined) throw new Error('The second exchange has no summary.');
		if (followUpClosingContext === undefined)
			throw new Error('The second closing activation was not captured.');

		expect(firstSummary.text).toContain('approved count is 8');
		expect(firstSummary.text).toContain('Mira owns the project');
		expect(firstSummary.text).toContain('office opens Tuesday');
		expect(secondMessages.filter((message) => message.kind === 'said')).toHaveLength(1);
		expect(secondMessages.some((message) => message.from === 'assistant')).toBe(false);
		expect(followUpOrdinaryActivations).toBe(1);
		expect(followUpClosingContext).toContain('The approved count is 8.');
		expect(followUpClosingContext).toContain('Mira owns the project.');
		expect(followUpClosingContext).toContain('office opens Tuesday');
		expect(followUpClosingContext).toContain('Who owns the project?');
		expect(secondSummary.text).toBe('Mira owns the project.');
		expect(secondSummary.to).toBe('priya');
		expect(secondSummary.covers).toEqual({
			from: secondMessages[0]?.seq,
			through: secondMessages.at(-1)?.seq,
		});
		expect(secondSummary.covers.from).not.toBe(firstSummary.covers.from);
	} finally {
		await session.stop();
	}
});
