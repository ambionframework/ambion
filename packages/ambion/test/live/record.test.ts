/**
 * The record belongs to the name. `docs/agent.md` §5: a session outlives any
 * run of it, and the next run's seats read the record the last run left. A
 * real model reads that record as prose, and answers from it.
 */
import { expect, it } from 'vitest';
import {
	InMemorySessionRepo,
	isPresence,
	readSession,
	startSession,
	stopSession,
	visitSession,
} from '../../src/internal.ts';
import { collect, roomName } from '../support/room.ts';
import {
	agent,
	assistant,
	invariants,
	live,
	person,
	report,
	saidBy,
	spent,
	untilQuiet,
} from './support.ts';

live('the record', () => {
	it('a second run reads what the first run left, and the seat answers from it', async () => {
		const memo = agent('memo', {
			identity: 'Keeps what people tell it.',
			instructions: `
				When somebody gives you a code, acknowledge it with one say, in one
				short sentence. When somebody asks for a code, read the record above
				and answer with one say, quoting the code exactly.
			`,
		});
		const repo = new InMemorySessionRepo();
		const name = roomName('record');

		const first = startSession({ name, assistant, repo, agents: [memo] });
		const firstEvents = collect(first);
		const told = await visitSession(first, person);
		await told.deliver({ text: 'The door code for the yard is 4419. Keep it.' });
		await untilQuiet(first);
		await invariants(first, firstEvents);
		await stopSession(first);

		const second = startSession({ name, assistant, repo, agents: [memo] });
		const secondEvents = collect(second);
		const asked = await visitSession(second, person);
		await asked.deliver({ text: 'What is the door code for the yard?' });
		await untilQuiet(second);

		const messages = await readSession(name, { repo }).messages();
		const answers = saidBy(messages, 'memo');
		expect(answers.at(-1)?.text).toContain('4419');
		// One record, two runs: the person arrived twice and left once between.
		expect(messages.filter(isPresence).map((m) => m.kind)).toEqual(['arrived', 'left', 'arrived']);
		expect(saidBy(messages, person.name)).toHaveLength(2);
		await invariants(second, secondEvents);
		const total = await spent(repo, name);
		expect(total.activations).toBeGreaterThanOrEqual(2);
		report('the record', total);
		await stopSession(second);
	});
});
