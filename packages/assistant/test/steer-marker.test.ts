import {
	createRuntime,
	defineAgent,
	defineHuman,
	pi,
	type Room,
	startRoom,
} from '@ambionframework/ambion';
import { isClosing, quiet, scripted, speak } from '@ambionframework/ambion/testing';
import type { Context } from '@earendil-works/pi-ai';
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
	// The assistant ends its pass only after the specialist has spoken.
	const untilSpecialistSpoke = async () => {
		for (let wait = 0; wait < 200 && !(await specialistSpoke()); wait += 1) await sleep(10);
		await sleep(50);
	};
	const runtime = createRuntime({
		stream: scripted(async (context, seat) => {
			const tail = context.messages.at(-1);
			if (seat === 'inventory') {
				const first = !specialistAnswered;
				specialistAnswered = true;
				return first ? speak('There are 8 units in stock.', 'assistant') : quiet();
			}
			if (isClosing(context)) return speak('8 units.');
			if (tail?.role === 'user' && lastText(context).startsWith('[')) {
				captured = { system: context.systemPrompt ?? '', steered: lastText(context) };
				return quiet();
			}
			if (tail?.role !== 'toolResult') return speak('Check the stock of SKU A.', 'inventory');
			await untilSpecialistSpoke();
			return quiet();
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
