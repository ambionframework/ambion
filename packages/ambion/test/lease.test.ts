/**
 * A wake is safe to send twice, a lost one is sent again, a lost release
 * expires, and a lost wake into a running activation is read off the
 * record. Rule 4 of the design:
 * every activation's id is derived from the log, so nothing that crosses
 * the wire has to arrive exactly once.
 */
import type { Context } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	inProcessTransport,
	isSpoken,
	isSummary,
	type LeaseRow,
	type SeatRoom,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { assistant, collect, deferred, enter, roomName, rowsOf, tick } from './support/room.ts';
import {
	byAgent,
	contextText,
	quiet,
	type Script,
	says,
	scripted,
	speak,
	summarise,
	toolNames,
} from './support/scripted.ts';
import { gatedOpener, memory } from './support/storage.ts';
import { type Fault, faultyTransport } from './support/transport.ts';

const solo = defineAgent({
	name: 'solo',
	identity: 'Speaks once.',
	instructions: 'speak',
	model: 'scripted/solo',
});

const started: Session[] = [];
afterEach(async () => {
	for (const session of started.splice(0)) await stopSession(session);
});

function open(faults: Fault[], script: Script): { session: Session; clock: FakeClock } {
	const clock = fakeClock();
	const runtime = createRuntime({
		clock,
		transport: faultyTransport(inProcessTransport(), faults, clock),
	});
	const session = startSession({
		name: roomName('lease'),
		assistant,
		agents: [solo],
		runtime,
		streamFn: scripted(script),
	});
	started.push(session);
	return { session, clock };
}

const starts = (events: ReturnType<typeof collect>) =>
	events.filter((e) => e.type === 'activation_start').length;

describe('a lease', () => {
	it('sends a dropped wake again after the resend window, and the seat runs once', async () => {
		const { session, clock } = open([{ on: 'wake', kind: 'drop' }], (_c, _a, call) =>
			call === 1 ? speak('hi') : quiet(),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'say hi' });
		await tick();
		expect(starts(events)).toBe(0);

		await clock.advance(4_999);
		expect(starts(events)).toBe(0);
		await clock.advance(1);
		await session.quiet();
		expect(starts(events)).toBe(1);
		expect((await session.messages()).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
	});

	it('runs one activation for a duplicated wake', async () => {
		const { session } = open([{ on: 'wake', kind: 'duplicate' }], (_c, _a, call) =>
			call === 1 ? speak('hi') : quiet(),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'say hi' });
		await session.quiet();
		expect(starts(events)).toBe(1);
		expect((await session.messages()).filter(isSpoken)).toHaveLength(2);
	});

	it('expires a lease whose release was lost, and answers the late release stale', async () => {
		const { session, clock } = open(
			[{ on: 'lease', kind: 'drop', match: (l) => (l as { phase: string }).phase === 'ended' }],
			(_c, _a, call) => (call === 1 ? speak('hi') : quiet()),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'say hi' });
		await tick();
		await tick();
		// the seat spoke, its release was lost, and the room still holds the lease
		expect((await session.messages()).filter(isSpoken).map((m) => m.from)).toContain('solo');
		expect(events.some((e) => e.type === 'activation_end')).toBe(false);
		expect(session.exchange()).toBeDefined();

		await clock.advance(60_000);
		await session.quiet();
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		expect(session.exchange()).toBeUndefined();

		const room = session as unknown as SeatRoom;
		await expect(
			room.lease({ activation: '2:solo', phase: 'ended', reason: 'released' }),
		).resolves.toEqual({
			stale: 'the lease ended',
		});
	});

	it('refuses a commit from an activation whose renewals were lost past the expiry', async () => {
		const held = deferred();
		// the claim goes through; the one renewal before the expiry is lost
		const renewals = (l: unknown) => (l as { phase: string }).phase === 'running';
		const faults: Fault[] = [{ on: 'lease', kind: 'drop', match: renewals, skip: 1 }];
		const { session, clock } = open(faults, async (_c, _a, call) => {
			if (call !== 1) return quiet();
			await held.promise;
			return speak('too late');
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'go' });
		await tick();
		expect(starts(events)).toBe(1);

		// half the expiry: the renewal is lost; the whole expiry: the lease ends
		await clock.advance(60_000);
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		held.resolve();
		await tick();
		await tick();
		// the say arrived under a lease that ended, so nothing landed
		expect((await session.messages()).filter(isSpoken).map((m) => m.from)).toEqual(['andrei']);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		// a lease that expired without a word answers nothing: the exchange stays
		// open, and the seat is woken again after the backoff
		expect(session.exchange()).toMatchObject({ owner: 'andrei' });
		expect(starts(events)).toBe(1);
		await clock.advance(30_000);
		await session.quiet();
		expect(starts(events)).toBe(2);
		expect(session.exchange()).toBeUndefined();
	});

	it('rebuilds the activation when a wake into it was lost, and reads the message off the record', async () => {
		const held = deferred();
		const contexts: string[] = [];
		// the first wake starts the activation; the second, the steer into it, is lost
		const { session } = open([{ on: 'wake', kind: 'drop', skip: 1 }], async (context, _a, call) => {
			contexts.push(contextText(context as Context));
			if (call === 1) await held.promise;
			return quiet();
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'first' });
		await tick();
		await visit.deliver({ text: 'second' });
		held.resolve();
		await session.quiet();

		expect(starts(events)).toBe(1);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]).not.toContain('second');
		expect(contexts[1]).toContain('second');
	});
});

describe('a lease judged where its row is written', () => {
	const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

	it('keeps a lease whose renewal landed ahead of the expiry the alarm decided', async () => {
		const clock = fakeClock();
		const base = await memory.open();
		const gate = deferred();
		let runningRows = 0;
		// the claim lands at once; the first renewal is held on the storage
		const sessions = gatedOpener(base.sessions, (type, data) => {
			const row = data as LeaseRow;
			if (type !== 'ambion/lease' || row.phase !== 'running' || !row.id.endsWith(':solo')) {
				return undefined;
			}
			runningRows += 1;
			return runningRows === 2 ? gate.promise : undefined;
		});
		const held = deferred();
		const session = startSession({
			name: roomName('lease-renewal'),
			assistant,
			agents: [solo],
			runtime: createRuntime({ clock, sessions }),
			streamFn: scripted(async (_c, _a, call) => {
				if (call !== 1) return quiet();
				await held.promise;
				return speak('late but alive');
			}),
		});
		started.push(session);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'go' });
		await tick();
		// half the expiry: the renewal is asked for, and its row waits on the storage
		await clock.advance(30_000);
		expect(runningRows).toBe(2);
		// the expiry: the alarm decides on the fold that still shows it, behind the renewal
		await clock.advance(30_000);
		gate.resolve();
		await tick();
		await tick();
		await tick();
		expect(events.filter((e) => e.type === 'error')).toHaveLength(0);

		held.resolve();
		await session.quiet();
		expect((await session.messages()).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
		const rows = (await rowsOf(base.sessions, session.name))
			.filter((r) => r.type === 'ambion/lease')
			.map((r) => r.data as LeaseRow)
			.filter((l) => l.id.endsWith(':solo'));
		// the claim, the renewal, the check at the run's end, and one release: no expiry
		expect(rows.filter((l) => l.phase === 'ended').map((l) => l.reason)).toEqual(['released']);
	});

	it('hands a draft every close its person is owed, when a later close joined it under the claim', async () => {
		const clock = fakeClock();
		const opened = await memory.open();
		// the view of the second attempt at the draft is delayed on the wire
		const runtime = createRuntime({
			clock,
			sessions: opened.sessions,
			transport: faultyTransport(
				inProcessTransport(),
				[
					{
						on: 'view',
						kind: 'delay',
						ms: 10_000,
						match: (id) => typeof id === 'string' && id.startsWith('close:') && id.endsWith(':2'),
					},
				],
				clock,
			),
		});
		const held = deferred();
		const session = startSession({
			name: roomName('lease-draft'),
			assistant,
			agents: [solo],
			runtime,
			streamFn: scripted(
				byAgent({
					solo: async (context, name, call) => {
						if (!contextText(context).includes('Second?')) {
							return says(['a1', 'a2'])(context, name, call);
						}
						await held.promise;
						return says(['a3', 'a4'])(context, name, call);
					},
					assistant: (context, _name, call) => {
						if (!toolNames(context).includes('summarise')) return quiet();
						if (call === 1) throw new Error('the model failed');
						return summarise('The one message.');
					},
				}),
			),
		});
		started.push(session);
		const events = collect(session);
		const visit = await visitSession(session, priya);
		await visit.deliver({ text: 'First?' });
		await session.quiet();
		expect((await session.messages()).filter(isSummary)).toHaveLength(0);

		// the seat works on the second exchange when the backoff passes and the draft is claimed
		await visit.deliver({ text: 'Second?' });
		await tick();
		await tick();
		await clock.advance(30_000);
		expect(session.seats().find((s) => s.name === 'assistant')).toMatchObject({
			status: 'active',
		});
		// the seat finishes while the draft's view is on the wire: a second close joins the draft
		held.resolve();
		await tick();
		await tick();
		await tick();
		await tick();
		expect(events.filter((e) => e.type === 'exchange_closed')).toHaveLength(2);
		await clock.advance(10_000);
		await session.quiet();
		await clock.advance(200_000);
		await session.quiet();

		const record = await session.messages();
		const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
		const summaries = record.filter(isSummary);
		expect(summaries).toHaveLength(1);
		expect(summaries[0]?.covers.from).toBe(questions[0]?.seq);
		expect(summaries[0]?.covers.through).toBe((summaries[0]?.seq ?? 0) - 1);
	});
});
