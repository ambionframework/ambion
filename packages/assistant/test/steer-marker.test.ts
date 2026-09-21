import {
	createRuntime,
	defineAgent,
	defineHuman,
	type Room,
	startRoom,
} from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import {
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { defineAssistant } from '../src/index.ts';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The text of the last message in a provider request. */
function lastText(context: Context): string {
	const content = context.messages.at(-1)?.content;
	if (typeof content === 'string') return content;
	return (content ?? []).map((part) => ('text' in part ? part.text : '')).join('');
}

/**
 * Run one exchange with scripted models. The assistant routes the question and ends. Only
 * then does the specialist speak, so the room steers the result into the assistant.
 * Return the system prompt and the last message of the request that follows the steer.
 */
async function requestAfterSteer(): Promise<{ system: string; steered: string }> {
	let room: Room | undefined;
	let specialistAnswered = false;
	let captured: { system: string; steered: string } | undefined;
	const specialistSpoke = async () => {
		const snapshot = await room?.read({ messages: { since: 0 } });
		return snapshot?.messages.some((m) => m.kind === 'said' && m.from === 'inventory') ?? false;
	};
	const runtime = createRuntime({
		execution: piExecution({
			stream: (model, context) => {
				const out = createAssistantMessageEventStream();
				const closing = context.tools?.length === 1;
				const tail = context.messages.at(-1);
				const steered = tail?.role === 'user' && lastText(context).startsWith('[');
				let message = fauxAssistantMessage('', { stopReason: 'stop' });
				let hold = false;
				if (model.id.endsWith('inventory')) {
					if (!specialistAnswered)
						message = fauxAssistantMessage(
							[fauxToolCall('say', { to: 'assistant', text: 'There are 8 units in stock.' })],
							{ stopReason: 'toolUse' },
						);
					specialistAnswered = true;
				} else if (closing) {
					message = fauxAssistantMessage([fauxToolCall('say', { text: '8 units.' })], {
						stopReason: 'toolUse',
					});
				} else if (steered) {
					captured = { system: context.systemPrompt ?? '', steered: lastText(context) };
				} else if (tail?.role === 'toolResult') {
					hold = true;
				} else {
					message = fauxAssistantMessage(
						[fauxToolCall('say', { to: 'inventory', text: 'Check the stock of SKU A.' })],
						{ stopReason: 'toolUse' },
					);
				}
				void (async () => {
					out.push({ type: 'start', partial: message });
					if (hold) {
						for (let wait = 0; wait < 200 && !(await specialistSpoke()); wait += 1) await sleep(10);
						await sleep(50);
					}
					out.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
				})();
				return out;
			},
		}),
	});
	room = await startRoom({
		name: 'steer-marker',
		assistant: defineAssistant({ model: 'scripted/assistant' }),
		agents: [
			defineAgent({
				name: 'inventory',
				identity: 'Checks stock.',
				executor: pi({ instructions: 'Report the stock once.', model: 'scripted/inventory' }),
			}),
		],
		seats: { inventory: 'named' },
		runtime,
	});
	try {
		const exchange = await (
			await room.visit(defineHuman({ name: 'priya', identity: 'Owns the request.' }))
		).send({ text: 'How many units of SKU A can we dispatch?' });
		await exchange.waitForSummary();
		if (!captured) throw new Error('The assistant never received the steered result.');
		return captured;
	} finally {
		await room.stop();
	}
}

it('names the marker that the room puts on a specialist result steered into the assistant', async () => {
	const { system, steered } = await requestAfterSteer();
	const marker = /^\[[^\]]+\]/.exec(steered)?.[0];

	expect(steered).toContain('[inventory → assistant] There are 8 units in stock.');
	expect(marker).toBeDefined();
	// The guidance and the marker change together. A marker of [steer] raised the rate of
	// relayed results from 5 in 30 to 18 in 30 in a live trial. Measure before a rename.
	expect(system).toContain(`starts with \`${marker}\``);
});
