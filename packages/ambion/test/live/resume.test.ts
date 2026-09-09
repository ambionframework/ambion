/**
 * A room resumed over its log continues the exchange a crash cut through.
 * `docs/exchange.md` §5: a second runtime over the same storage resumes the
 * name while a seat is active on a real model, the lease that seat held
 * expires on the resumed room's own alarm, the exchange closes, and the
 * assistant writes the summary. A scripted stream proves the mechanism;
 * only a real request proves that a seat cut mid-request leaves the record
 * whole.
 */
import { expect, it } from 'vitest';
import {
	createRuntime,
	InMemorySessionRepo,
	isSummary,
	resumeSession,
	startSession,
	stopSession,
	visitSession,
} from '../../src/index.ts';
import { collect, roomName } from '../support/room.ts';
import {
	agent,
	assistant,
	invariants,
	live,
	person,
	report,
	spent,
	untilQuiet,
	within,
} from './support.ts';

live('resume', () => {
	it('a second runtime resumes a room mid-exchange, expires the lease it held, and writes the summary', async () => {
		const planner = agent('planner', {
			identity: 'Production planner.',
			instructions:
				'When asked about the batch, say in one sentence that production finishes on Thursday.',
		});
		const logistics = agent('logistics', {
			identity: 'Logistics desk.',
			instructions:
				'When asked about the batch, say in one sentence that the carrier collects on Friday.',
		});
		const repo = new InMemorySessionRepo();
		const name = roomName('resume');
		// A short expiry: the lease the crashed run held ends within the test's deadline.
		const first = createRuntime({
			repo,
			agents: [assistant, planner, logistics],
			wake: { expiry: 15_000 },
		});
		const session = startSession({ name, assistant, agents: [planner, logistics], runtime: first });
		const started = new Promise<void>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'activation_start' && e.agent === 'planner') resolve();
			});
		});
		const visit = await visitSession(session, person);
		await visit.deliver({ text: 'Can we ship the batch on Friday?' });
		await within(started, 30_000, 'the planner starting');
		// The run dies mid-request: no lease is released, and no left is written.
		first.evict(name);

		const second = createRuntime({
			repo,
			agents: [assistant, planner, logistics],
			wake: { expiry: 15_000 },
		});
		const resumed = await resumeSession(name, { runtime: second });
		const events = collect(resumed);
		expect(resumed.exchange()).toMatchObject({ owner: person.name });
		await untilQuiet(resumed);

		const messages = await resumed.messages();
		expect(resumed.exchange()).toBeUndefined();
		expect(messages.filter(isSummary)).toHaveLength(1);
		// the lease the first run held expired on the resumed room's alarm
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		await invariants(resumed, events, { allowErrors: 1 });
		report('resume', await spent(repo, name));
		await stopSession(resumed);
	});
});
