/**
 * An exchange closes into one message. `docs/exchange.md` and
 * `docs/assistant.md`: a question opens an exchange, the seats answer in
 * parallel under the say lock, the room goes quiet, and the assistant writes
 * for the person in the shape their preferences ask for. On a real model the
 * seats race for real, and the room going quiet at all is the gap
 * `docs/agent.md` §7 names.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import {
	defineHuman,
	defineTool,
	isClosed,
	isPresence,
	isSummary,
	stopSession,
} from '../../src/index.ts';
import { enter } from '../support/room.ts';
import {
	activationsOf,
	agent,
	invariants,
	live,
	open,
	report,
	saidBy,
	saidByAgents,
	spent,
	untilQuiet,
} from './support.ts';

const andrei = defineHuman({
	name: 'andrei',
	identity: 'Founder. Decides whether the batch ships.',
	preferences: `
		Open with the single word VERDICT in capitals, then a colon, then the
		decision. Two sentences at most.
	`,
});

/** A seat that holds one fact and states it once when a question turns on it. */
const holder = (name: string, identity: string, fact: string) =>
	agent(name, {
		identity,
		instructions: `
			The one fact you hold: ${fact}
			When a question turns on it, state it once with one say, in one
			sentence. When a colleague has already said it, or the question does
			not turn on it, end your turn without calling say.
		`,
	});

live('the exchange', () => {
	it('the seats race, the room goes quiet, and the assistant writes for the person', async () => {
		const planner = holder(
			'planner',
			'Production planner.',
			'production of the batch finishes on Thursday at 16:00.',
		);
		const logistics = holder(
			'logistics',
			'Logistics desk.',
			'the carrier collects on Friday at 09:00, and needs the pallets wrapped by Thursday 18:00.',
		);
		const finance = holder(
			'finance',
			'Finance desk.',
			'shipping on Friday costs nothing extra; a Saturday collection carries a 200 EUR surcharge.',
		);
		const { session, repo, events } = open('exchange', {
			goal: 'Ship the batch this week.',
			agents: [planner, logistics, finance],
		});
		const visit = await enter(session, andrei);
		await visit.deliver({ text: 'Can we ship the batch on Friday?' });
		await untilQuiet(session);

		const messages = await session.messages();
		const question = saidBy(messages, andrei.name)[0];
		expect(question).toBeDefined();
		// Two facts at least were needed, so the assistant owed a message.
		expect(saidByAgents(messages, [andrei.name]).length).toBeGreaterThanOrEqual(2);
		const summaries = messages.filter(isSummary);
		expect(summaries).toHaveLength(1);
		const summary = summaries[0];
		expect(summary).toMatchObject({ from: 'assistant', to: andrei.name });
		expect(summary?.covers.from).toBe(question?.seq);
		expect(summary?.covers.through).toBe((summary?.seq ?? 0) - 1);
		expect(summary?.text.trim()).toMatch(/^VERDICT:/);
		expect(
			summary?.text
				.trim()
				.split(/[.!?](\s|$)/)
				.filter(Boolean).length,
		).toBeLessThanOrEqual(4);

		const opened = events.filter((e) => e.type === 'exchange_opened');
		const closed = events.filter((e) => e.type === 'exchange_closed');
		expect(opened).toHaveLength(1);
		expect(closed).toHaveLength(1);
		// The close is a message, so the event and the record say the same thing.
		const close = messages.filter(isClosed).at(-1);
		expect(closed[0]).toMatchObject({
			exchange: {
				owner: andrei.name,
				from: close?.covers.from,
				through: close?.covers.through,
			},
		});
		// The summary lands after the close, so it covers the close as well.
		expect(summary?.covers.through).toBe(close?.seq);
		// The room went quiet on judgment: three seats, and a bounded number of glances.
		const glances = ['planner', 'logistics', 'finance'].reduce(
			(sum, name) => sum + activationsOf(events, name),
			0,
		);
		expect(glances).toBeLessThanOrEqual(15);
		expect(saidByAgents(messages, [andrei.name]).length).toBeLessThanOrEqual(6);
		await invariants(session, events);
		const conflicts = events.filter((e) => e.type === 'conflict').length;
		report('the exchange', await spent(repo, session.name), conflicts);
		await stopSession(session);
	});

	it('the assistant seats the specialist a question needs, and leaves the rest in reserve', async () => {
		const leadTime = defineTool({
			name: 'permit_lead_time',
			description: 'How long building control takes to issue a permit.',
			parameters: Type.Object({ kind: Type.String({ description: 'The kind of work.' }) }),
			execute: async () => 'A permit takes 10 working days from a complete application.',
		});
		const frontdesk = agent('frontdesk', {
			identity: 'Front desk. Answers general questions.',
			instructions: `
				Answer a general question with one say, in one sentence. A question
				about building permits is for the permits liaison: end your turn
				without calling say.
			`,
		});
		const permits = agent('permits', {
			identity: 'Building control liaison. Knows permit lead times.',
			instructions: `
				When asked how long a permit takes, call permit_lead_time, then answer
				with one say, in one sentence. Quote the lead time.
			`,
			tools: [leadTime],
		});
		const catering = agent('catering', {
			identity: 'Canteen desk. Knows menus and meal times.',
			instructions: 'Answer questions about meals with one say. For anything else, end your turn.',
		});
		const { session, repo, events } = open('reserve', {
			agents: [frontdesk],
			available: [permits, catering],
		});
		const visit = await enter(session, andrei);
		await visit.deliver({ text: 'How long does a building permit take for the extension?' });
		await untilQuiet(session);

		const messages = await session.messages();
		const seatings = messages.filter(isPresence).filter((m) => m.kind === 'seated');
		expect(seatings.map((m) => m.from)).toEqual(['permits']);
		expect(seatings[0]).toMatchObject({ by: 'assistant', identity: permits.identity });
		expect(session.seats().map((seat) => seat.name)).toContain('permits');
		expect(session.seats().map((seat) => seat.name)).not.toContain('catering');
		const answer = saidBy(messages, 'permits');
		expect(answer).toHaveLength(1);
		expect(answer[0]?.text).toContain('10 working days');
		await invariants(session, events);
		report('the reserve', await spent(repo, session.name));
		await stopSession(session);
	});
});
