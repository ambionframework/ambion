/**
 * A room resumed over its log continues the exchange a crash cut through.
 * `docs/exchange.md` §5: a second runtime over the same storage resumes the
 * name while a seat is active on a real model, the wake the crash left
 * pending is sent again, the lease the cut seat held expires on the resumed
 * room's own alarm, the exchange closes, and the assistant writes the
 * summary. A scripted stream proves the mechanism; only a real request
 * proves that a seat cut mid-request leaves the record whole.
 *
 * The crash lands on the first say: the say is on the log, its author's
 * lease is still running, and the say reaches the other seat. Two seats
 * speak across the two runs, so the close owes a summary
 * (`docs/assistant.md` §4).
 */
import { expect, it } from 'vitest';
import {
	createRuntime,
	InMemorySessionRepo,
	isSpoken,
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
	errorsIn,
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
			instructions: `
				When asked about the batch, say in one sentence that production
				finishes on Thursday. Say it even when a colleague has answered
				already, and say nothing else.
			`,
		});
		const logistics = agent('logistics', {
			identity: 'Logistics desk.',
			instructions: `
				When asked about the batch, say in one sentence that the carrier
				collects on Friday. Say it even when a colleague has answered
				already, and say nothing else.
			`,
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
		const before = collect(session);
		// The run dies as the first say lands: the say is on the log, its
		// author's lease is not released, and no left is written.
		const seats = new Set([planner.name, logistics.name]);
		let spoke = '';
		const cut = new Promise<void>((resolve) => {
			session.subscribe((e) => {
				if (e.type !== 'message' || !isSpoken(e.message) || !seats.has(e.message.from)) return;
				if (spoke !== '') return;
				spoke = e.message.from;
				first.evict(name);
				resolve();
			});
		});
		const visit = await visitSession(session, person);
		await visit.deliver({ text: 'Can we ship the batch on Friday?' });
		await within(cut, 60_000, `a seat speaking (errors: ${JSON.stringify(errorsIn(before))})`);

		const second = createRuntime({
			repo,
			agents: [assistant, planner, logistics],
			wake: { expiry: 15_000 },
		});
		const resumed = await resumeSession(name, { runtime: second });
		const events = collect(resumed);
		expect(resumed.exchange()).toMatchObject({ owner: person.name });
		// the leases the first run held: the speaker's, and the other seat's if it was mid-request
		const inherited = resumed
			.seats()
			.filter((s) => s.kind === 'agent' && s.status === 'active').length;
		expect(inherited).toBeGreaterThanOrEqual(1);
		await untilQuiet(resumed);

		const messages = await resumed.messages();
		expect(resumed.exchange()).toBeUndefined();
		// both seats spoke across the two runs, and the other seat spoke in this one
		const other = spoke === planner.name ? logistics.name : planner.name;
		const said = messages.filter(isSpoken).map((m) => m.from);
		expect(said).toContain(spoke);
		expect(said).toContain(other);
		expect(events.some((e) => e.type === 'message' && e.message.from === other)).toBe(true);
		expect(messages.filter(isSummary)).toHaveLength(1);
		// the lease the speaker held at the cut expired on the resumed room's alarm
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		// the inherited leases expired: one error each, and one end without a start
		await invariants(resumed, events, {
			allowErrors: inherited,
			inherited,
			inheritedExchange: true,
		});
		report('resume', await spent(repo, name));
		await stopSession(resumed);
	});
});
