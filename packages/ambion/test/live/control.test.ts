/**
 * Cancellation records one durable cut. Provider and tool termination remains
 * best effort, and the room stays available for a later exchange. A message
 * that lands while a seat works reaches the seat, and its answer covers it.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { defineTool } from '../../src/index.ts';
import { enter, messagesOf } from '../support/room.ts';
import {
	agent,
	errorsIn,
	invariants,
	LIVE_KIND,
	live,
	open,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
	within,
} from './support.ts';

/** A tool that keeps the activation busy long enough for a second message to land. */
const calendar = defineTool({
	name: 'check_calendar',
	description: 'Look the date up in the site calendar. Takes a few seconds.',
	parameters: Type.Object({ topic: Type.String() }),
	execute: async () => {
		await new Promise((resolve) => setTimeout(resolve, 8_000));
		return 'The calendar is free on Saturday.';
	},
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

live('control', () => {
	it('cancel ends an activation mid-request without a mark, and the room keeps running', async () => {
		const essayist = agent('essayist', {
			identity: 'Writes at length.',
			instructions: `
				When asked for an essay, write one of at least 800 words and deliver
				it with one say. When told to drop the essay and say one word, say
				that word alone with one say, and write no essay.
			`,
		});
		const { session, events } = await open('cancel', { agents: [essayist] });
		const visit = await enter(session, person);
		const started = new Promise<void>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'activation_start' && e.seat === 'essayist') resolve();
			});
		});
		const exchange = await visit.send({ text: 'Write me an essay on the history of concrete.' });
		await within(started, 30_000, 'the activation starting');
		// Long enough for the request to be open and streaming; too short for an essay.
		await settle(2_000);
		await session.cancel();
		await within(exchange.waitForClose(), 15_000, 'the exchange closing after cancel');

		expect(saidBy(await messagesOf(session), 'essayist')).toEqual([]);
		expect(errorsIn(events)).toEqual([]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'activation_end',
				seat: 'essayist',
				activation: expect.any(String),
				said: false,
			}),
		);

		// The room is still running: the next question is answered. The cancelled
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
		report('cancel', await spent(session));
		await session.stop();
	});

	it('a message sent while the seat works reaches it, and its answer covers both messages', async () => {
		const clerk = agent('clerk', {
			identity: 'Site clerk. Answers scheduling questions.',
			instructions: `
				When somebody asks a question, call check_calendar first. After it
				returns, answer with one say that covers everything the person has
				asked or told you, in one or two sentences.
			`,
			tools: [calendar],
		});
		const { session, events, records } = await open('steer', { agents: [clerk] });
		const visit = await enter(session, person);
		const started = new Promise<string>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'tool_call' && e.name === 'check_calendar') resolve(e.activation);
			});
		});
		await visit.send({ text: 'When can we pour the slab?' });
		const activation = await within(started, 60_000, 'the tool starting');
		await visit.send({ text: 'Also: the inspector visits on Friday. Name that day too.' });
		await untilQuiet(session);

		const messages = await messagesOf(session);
		const second = saidBy(messages, person.name)[1];
		const answer = saidBy(messages, 'clerk').at(-1);
		expect(answer?.seq ?? 0).toBeGreaterThan(second?.seq ?? Number.POSITIVE_INFINITY);
		expect(answer?.text).toMatch(/friday/i);
		// Codex takes no line into a live pass: its next pass reads the record.
		if (LIVE_KIND !== 'codex') {
			const steps = records.flatMap((r) => (r.step.activation === activation ? [r.step] : []));
			expect(steps).toContainEqual(
				expect.objectContaining({ type: 'steer', seq: second?.seq, consumed: true }),
			);
		}
		expect(errorsIn(events)).toEqual([]);
		await invariants(session, events);
		report('steer', await spent(session));
		await session.stop();
	});
});
