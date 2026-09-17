import {
	createRuntime,
	defaultRuntime,
	defineAgent,
	defineHuman,
	type Attention,
	type CreateRuntimeOptions,
	type Message,
} from '@ambionframework/ambion';
import { startRoom } from '@ambionframework/ambion';
import {
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { defineAssistant } from '../../src/index.ts';

const model = process.env.AMBION_MODEL ?? 'anthropic/claude-sonnet-5';
const provider = model.split('/')[0]?.toUpperCase().replace(/-/g, '_');
const live = describe.skipIf(!process.env[`${provider}_API_KEY`]);
const person = defineHuman({ name: 'priya', identity: 'Owns the request.' });

/** Only the assistant uses the provider. The specialist supplies controlled evidence. */
async function evaluate(options: {
	question: string;
	fact: string;
	attention?: Attention;
	instructions?: string;
}) {
	const resolved = await defaultRuntime.model(model, 'assistant');
	let answered = false;
	const stream: NonNullable<CreateRuntimeOptions['stream']> = (requested, context, settings) => {
		if (requested.id === model) return defaultRuntime.stream(resolved, context, settings);
		const result = createAssistantMessageEventStream();
		const message = answered
			? fauxAssistantMessage('', { stopReason: 'stop' })
			: fauxAssistantMessage([fauxToolCall('say', { text: options.fact, to: 'assistant' })], {
					stopReason: 'toolUse',
				});
		answered = true;
		queueMicrotask(() => {
			result.push({ type: 'start', partial: message });
			result.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
		});
		return result;
	};
	const assistant = defineAssistant({ model, instructions: options.instructions });
	const specialist = defineAgent({
		name: 'inventory',
		identity: 'Checks warehouse stock and prepares dispatch plans.',
		instructions: 'Report the stock evidence once.',
		model: 'scripted/inventory',
	});
	const room = await startRoom({
		name: `assistant-eval-${crypto.randomUUID()}`,
		assistant,
		agents: [specialist],
		seats: options.attention === undefined ? {} : { inventory: options.attention },
		runtime: createRuntime({ stream }),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const exchange = await (await room.visit(person)).send({ text: options.question });
		const summary = await Promise.race([
			exchange.waitForSummary(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('The assistant did not finish.')), 90_000);
			}),
		]);
		return { messages: await exchange.waitForClose(), summary };
	} finally {
		clearTimeout(timer);
		await room.stop();
	}
}

const assistantSpeech = (messages: readonly Message[]) =>
	messages.filter((message) => message.kind === 'said' && message.from === 'assistant');

live('default assistant judgment with controlled specialist evidence', () => {
	it.each([
		['broadcast', 1],
		['named', 1],
		['named', 2],
		['named', 3],
		[undefined, 1],
	] as const)(
		'routes %s participation without redundant prompt repetition (sample %i)',
		async (attention, _sample) => {
			const result = await evaluate({
				attention,
				question:
					'How many units of SKU A can the warehouse dispatch today? Use current stock evidence.',
				fact: 'The warehouse has 8 units of SKU A available to dispatch today.',
			});
			expect(
				result.messages.some((message) => message.kind === 'said' && message.from === 'inventory'),
			).toBe(true);
			const speech = assistantSpeech(result.messages);
			if (attention === 'named') {
				expect(speech, JSON.stringify(speech)).toHaveLength(1);
				expect(speech[0]).toMatchObject({ to: 'inventory' });
			} else {
				expect(speech).toEqual([]);
			}
			expect(result.summary?.text).toMatch(/8|eight/i);
		},
	);

	it.each([1, 2, 3])(
		'corrects clear reliance on a superseded constraint once (sample %i)',
		async () => {
			const result = await evaluate({
				attention: 'broadcast',
				question:
					'Prepare a warehouse dispatch plan. Correction: the approved limit is now 8 units; the old 10-unit limit is withdrawn. Do not dispatch anything.',
				fact: 'I will prepare a 10-unit dispatch plan using the old approved limit of 10.',
			});
			const speech = assistantSpeech(result.messages);
			expect(speech, JSON.stringify(result.messages)).toHaveLength(1);
			expect(speech[0]).toMatchObject({ text: expect.stringMatching(/8|eight/i) });
			expect(result.summary?.text).toMatch(/8|eight/i);
		},
	);

	it('does not steer valid work or turn an incomplete result into success', async () => {
		const result = await evaluate({
			attention: 'broadcast',
			question: 'Check whether the warehouse can dispatch 8 units today. Do not dispatch anything.',
			fact: 'I could not read current warehouse stock because the stock service is unavailable. Dispatch capacity remains unknown; nothing was dispatched.',
		});
		expect(assistantSpeech(result.messages)).toEqual([]);
		expect(result.summary?.text).toMatch(
			/unknown|unavailable|cannot|could not|couldn't|unable|unconfirmed/i,
		);
	});

	it('honors an application override of default silence', async () => {
		const result = await evaluate({
			attention: 'broadcast',
			question: 'Check warehouse stock for SKU A.',
			fact: 'There are 8 units of SKU A in stock.',
			instructions:
				'For this application, override default silence: publish exactly one ordinary message with the exact text "Inventory checkpoint recorded." for this exchange. Do not repeat it if it is already on the record. Write the closing summary normally.',
		});
		expect(assistantSpeech(result.messages)).toEqual([
			expect.objectContaining({ text: 'Inventory checkpoint recorded.' }),
		]);
		expect(result.summary?.text).toMatch(/8|eight/i);
	});

	it('preserves source-only verification limits in the closing summary', async () => {
		const result = await evaluate({
			attention: 'broadcast',
			question:
				'Report what was verified about the warehouse dispatch prototype. Do not change files or release anything.',
			fact: 'I inspected the source of the static dispatch prototype. The source contains a stock-count label. I did not render it in a browser, run tests, or deploy it. Runtime behavior remains unverified; no release occurred and no files changed.',
		});
		expect(assistantSpeech(result.messages)).toEqual([]);
		expect(result.summary?.text).toMatch(/source|static/i);
		expect(result.summary?.text).toMatch(
			/unverified|not (?:tested|verified|rendered)|no (?:runtime|browser|tests)|did not (?:render|run|test)/i,
		);
		expect(result.summary?.text).toMatch(
			/not (?:deployed|released)|no (?:deployment|release)|did not (?:deploy|release)|nothing (?:deployed|released)/i,
		);
	});
});
