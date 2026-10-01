/**
 * The eval support on the scripted tier: the room joins a Pi assistant and
 * the scripted `inventory` specialist, the specialist answers once in each
 * exchange, and the simulator drives the room. A scripted Pi stream plays
 * the assistant, so the live suite's plumbing runs with no key.
 */

import { byAgent, quiet, say, seat } from '@ambionframework/ambion/testing';
import { piExecution } from '@ambionframework/pi';
import {
	contextText,
	isClosingContext,
	type PiScript,
	scripted,
} from '@ambionframework/pi/testing';
import { scriptedActor, simulate } from '@ambionframework/simulator';
import { describe, expect, it } from 'vitest';
import { answers, openRoom, priya, saidBy } from './live/support.ts';

/**
 * An assistant that routes the first question once, and writes a summary
 * with the count. It keeps the context of each ordinary activation in `seen`.
 */
function assistant(route: Route, seen: string[]): PiScript {
	let routed = route === 'quiet';
	return byAgent({
		assistant: (context) => {
			if (isClosingContext(context)) {
				return contextText(context).includes('Summary:') ? quiet() : say('Summary: 8 units.');
			}
			seen.push(contextText(context));
			if (routed) return quiet();
			routed = true;
			return route === 'ask' ? say('Check the stock of SKU A.', 'inventory') : seat('inventory');
		},
	});
}

type Route = 'quiet' | 'ask' | 'seat';

const scriptedAssistant = (route: Route, seen: string[] = []) => ({
	model: 'scripted/assistant',
	execution: piExecution({ stream: scripted(assistant(route, seen)), sessions: 'memory' }),
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

	it('lands the departure of the person before the first activation of the assistant', async () => {
		const seen: string[] = [];
		const room = await openRoom({
			attention: 'named',
			leaves: priya,
			assistant: scriptedAssistant('ask', seen),
			specialist: answers(() => '8 units of SKU A.'),
		});
		const run = await simulate(room, {
			person: priya,
			actor: scriptedActor(['How many units of SKU A?']),
			exchanges: 1,
			exchangeMs: 10_000,
		});
		expect(run.ended, run.error).toBe('limit');
		const [exchange] = run.exchanges;
		// The departure follows the question in the exchange, and the person does not come back.
		expect(exchange?.discussion.map((message) => [message.kind, message.from])).toEqual([
			['said', 'priya'],
			['left', 'priya'],
			['said', 'assistant'],
			['said', 'inventory'],
		]);
		expect(run.room.messages.filter((message) => message.kind === 'left')).toHaveLength(1);
		// The first activation of the assistant already reads the person as absent.
		expect(seen[0]).toContain('- priya (absent');
		expect(exchange?.summary).toMatchObject({ to: 'priya', text: 'Summary: 8 units.' });
	});
});
