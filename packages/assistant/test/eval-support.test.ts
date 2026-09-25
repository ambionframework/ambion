/**
 * The eval support on the scripted tier: the room joins a Pi assistant and
 * the scripted `inventory` specialist, the specialist answers once in each
 * exchange, and the simulator drives the room. A scripted Pi stream plays
 * the assistant, so the live suite's plumbing runs with no key.
 */
import { piExecution } from '@ambionframework/pi';
import {
	byAgent,
	contextText,
	isClosing,
	quiet,
	type Script,
	scripted,
	seat,
	speak,
} from '@ambionframework/pi/testing';
import { scriptedActor, simulate } from '@ambionframework/simulator';
import { describe, expect, it } from 'vitest';
import { answers, openRoom, priya, saidBy } from './live/support.ts';

/** An assistant that routes the first question once, and writes a summary with the count. */
function assistant(route: Route): Script {
	let routed = route === 'quiet';
	return byAgent({
		assistant: (context) => {
			if (isClosing(context)) {
				return contextText(context).includes('Summary:') ? quiet() : speak('Summary: 8 units.');
			}
			if (routed) return quiet();
			routed = true;
			return route === 'ask' ? speak('Check the stock of SKU A.', 'inventory') : seat('inventory');
		},
	});
}

type Route = 'quiet' | 'ask' | 'seat';

const scriptedAssistant = (route: Route) => ({
	model: 'scripted/assistant',
	execution: piExecution({ stream: scripted(assistant(route)), sessions: 'memory' }),
});

describe('the eval support', () => {
	it.each([
		['broadcast', 'quiet', ['How many units of SKU A?', 'And SKU B?']],
		['named', 'ask', ['How many units of SKU A?']],
		[undefined, 'seat', ['How many units of SKU A?']],
	] as const)(
		'runs the questions at %s through the room and the specialist',
		async (attention, route, questions) => {
			const room = await openRoom({
				attention,
				assistant: scriptedAssistant(route),
				specialist: answers((exchange) =>
					exchange.some((message) => /SKU B/.test(message.text))
						? '5 units of SKU B.'
						: '8 units of SKU A.',
				),
			});
			const run = await simulate(room, {
				person: priya,
				actor: scriptedActor(questions),
				exchanges: questions.length,
				exchangeMs: 10_000,
			});
			expect(run.ended).toBe('limit');
			// The specialist answers once in each exchange, from what that exchange holds.
			expect(
				run.exchanges.map((exchange) => saidBy(exchange, 'inventory').map((m) => m.text)),
			).toEqual(
				['8 units of SKU A.', '5 units of SKU B.'].slice(0, questions.length).map((text) => [text]),
			);
			expect(run.exchanges[0]?.summary?.text).toBe('Summary: 8 units.');
			if (route === 'seat') {
				expect(run.room.messages).toContainEqual(
					expect.objectContaining({ kind: 'seated', subject: 'inventory', from: 'assistant' }),
				);
			}
			if (route === 'ask') {
				expect(saidBy(run.exchanges[0], 'assistant')).toEqual([
					expect.objectContaining({ to: 'inventory', text: 'Check the stock of SKU A.' }),
				]);
			}
		},
	);
});
