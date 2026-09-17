/**
 * Cancellation records one durable cut. Provider and tool termination remains
 * best effort, and the room stays available for a later exchange.
 */
import { expect, it } from 'vitest';
import { enter, messagesOf } from '../support/room.ts';
import {
	agent,
	errorsIn,
	invariants,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
	within,
} from './support.ts';

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

live('control', () => {
	it('abort ends an activation mid-request without a mark, and the room keeps running', async () => {
		const essayist = agent('essayist', {
			identity: 'Writes at length.',
			instructions: `
				When asked for an essay, write one of at least 800 words and deliver
				it with one say. When told to drop the essay and say one word, say
				that word alone with one say, and write no essay.
			`,
		});
		const { session, runtime, events } = await open('abort', { agents: [essayist] });
		const visit = await enter(session, person);
		const started = new Promise<void>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'activation_start' && e.agent === 'essayist') resolve();
			});
		});
		const exchange = await visit.send({ text: 'Write me an essay on the history of concrete.' });
		await within(started, 30_000, 'the activation starting');
		// Long enough for the request to be open and streaming; too short for an essay.
		await settle(2_000);
		await session.abort();
		await within(exchange.waitForClose(), 15_000, 'the exchange closing after abort');

		expect(saidBy(await messagesOf(session), 'essayist')).toEqual([]);
		expect(errorsIn(events)).toEqual([]);
		expect(events).toContainEqual({ type: 'activation_end', agent: 'essayist', spoke: false });

		// The room is still running: the next question is answered. The aborted
		// request left no mark, so the record still asks for the essay, and the
		// follow-up withdraws it in so many words.
		await visit.send({
			text: 'Drop the essay, do not write it. Say the word "ready" and nothing else.',
		});
		await untilQuiet(session);
		const said = saidBy(await messagesOf(session), 'essayist');
		expect(said).toHaveLength(1);
		expect(said[0]?.text).toMatch(/ready/i);
		expect(said[0]?.text.length).toBeLessThan(120);
		await invariants(session, events);
		report('abort', await spent(runtime, session));
		await session.stop();
	});
});
