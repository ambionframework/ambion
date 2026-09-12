/**
 * A wake is safe to send twice, a lost one is sent again, a lost release
 * expires, and a lost wake into a running activation is read off the
 * record. Rule 4 of the design:
 * every activation's id is derived from the journal, so nothing that crosses
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
	type LeaseChange,
	type Runtime,
	type SeatRoom,
	type Session,
	startSession,
	stopSession,
	type Visit,
	visitSession,
} from '../src/index.ts';
import { parseId } from '../src/room/lease.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import {
	assistant,
	collect,
	deferred,
	enter,
	messageBefore,
	roomName,
	storedOf,
	tick,
} from './support/room.ts';
import {
	answersEveryQuestion,
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

function open(
	faults: Fault[],
	script: Script,
	wake?: { expiry: number; deadline: number },
): { session: Session; clock: FakeClock; runtime: Runtime } {
	const clock = fakeClock();
	const runtime = createRuntime({
		clock,
		transport: faultyTransport(inProcessTransport(), faults, clock),
		...(wake === undefined ? {} : { wake }),
	});
	const session = startSession({
		name: roomName('lease'),
		assistant,
		agents: [solo],
		runtime,
		streamFn: scripted(script),
	});
	started.push(session);
	return { session, clock, runtime };
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

	it('expires a lease whose release was lost twice, and answers the late release stale', async () => {
		// a release the seat never heard back on is asked again once, so both are lost
		const ended = (l: unknown) => (l as { phase: string }).phase === 'ended';
		const { session, clock } = open(
			[
				{ on: 'lease', kind: 'drop', match: ended },
				{ on: 'lease', kind: 'drop', match: ended },
			],
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
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		// the expired lease answers nothing, whatever it said: the seat is woken again
		// after the backoff, reads its own words on the record, and stands down
		expect(session.exchange()).toBeDefined();
		await clock.advance(30_000);
		await session.quiet();
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(2);
		expect((await session.messages()).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
		expect(session.exchange()).toBeUndefined();

		const room = session as unknown as SeatRoom;
		await expect(
			room.lease({ activation: 'message:2:solo:1', phase: 'ended', reason: 'released' }),
		).resolves.toEqual({
			stale: 'the lease ended',
		});
	});

	it('expires an activation at its deadline, cuts it, and wakes the seat again after the backoff', async () => {
		const held = deferred();
		const { session, clock, runtime } = open(
			[],
			async (_c, _a, call) => {
				if (call !== 1) return quiet();
				await held.promise;
				return quiet();
			},
			{ expiry: 60_000, deadline: 120_000 },
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'take your time' });
		await tick();
		expect(starts(events)).toBe(1);

		// the room renews up to the deadline and no further, and expires the lease there
		await clock.advance(119_999);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		await clock.advance(1);
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		const stored = await storedOf(runtime.sessions, session.name);
		const renewals = stored.flatMap((entry) => {
			const lease = entry.data as LeaseChange;
			const mine = entry.type === 'ambion/lease' && parseId(lease.id)?.seat === 'solo';
			return mine && lease.phase === 'running' ? [lease.expiry] : [];
		});
		// the room wrote a claim and renewals, and no change takes the lease past the deadline
		expect(renewals.length).toBeGreaterThan(1);
		expect(renewals.every((expiry) => expiry <= clock.now())).toBe(true);

		// the activation came to nothing, so the seat is woken again after the backoff
		expect(session.exchange()).toBeDefined();
		await clock.advance(30_000);
		await session.quiet();
		expect(starts(events)).toBe(2);
		expect(session.exchange()).toBeUndefined();
		held.resolve();
	});

	it('gives up on a wake at the cap, writes the attempt it does not make, and closes', async () => {
		const { session, clock, runtime } = open([], () => {
			throw new Error('the model failed');
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'answer me' });
		await tick();
		// the first attempt failed; the second and the third fail after their backoffs
		await clock.advance(30_000);
		await clock.advance(60_000);
		await session.quiet();
		expect(events.filter((e) => e.type === 'error')).toHaveLength(3);

		// the room gives up: the attempt it does not make is on the record, once
		expect(events.filter((e) => e.type === 'abandoned')).toEqual([
			{ type: 'abandoned', agent: 'solo', activation: 'message:4:solo:4' },
		]);
		const stored = await storedOf(runtime.sessions, session.name);
		const gaveUp = stored.filter((entry) => {
			const lease = entry.data as LeaseChange;
			return (
				entry.type === 'ambion/lease' && lease.phase === 'ended' && lease.reason === 'abandoned'
			);
		});
		expect(gaveUp.map((entry) => (entry.data as LeaseChange).id)).toEqual(['message:4:solo:4']);

		// the wake is answered, so the exchange closes and the seat stands idle
		expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
		expect(session.exchange()).toBeUndefined();
		expect(session.seats().find((s) => s.name === 'solo')).toMatchObject({ status: 'idle' });
		// and the room stays that way: no fourth attempt starts, whatever the clock does
		await clock.advance(600_000);
		await session.quiet();
		expect(starts(events)).toBe(3);
	});

	it('gives up on a summary at the cap, and the range stays whole for every reader', async () => {
		const { session, clock, runtime } = open(
			[],
			byAgent({
				solo: says(['I answered.', 'And again.']),
				assistant: (context) => {
					if (!toolNames(context).includes('summarise')) return quiet();
					throw new Error('the model failed');
				},
			}),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.deliver({ text: 'answer me' });
		await session.quiet();
		// the close owes a summary, and the first draft failed
		expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
		await clock.advance(30_000);
		await clock.advance(60_000);
		await session.quiet();
		expect(events.filter((e) => e.type === 'error')).toHaveLength(3);

		// the room gives up on the summary, and says so once
		const abandoned = events.filter((e) => e.type === 'abandoned');
		expect(abandoned).toHaveLength(1);
		const givenUp = (abandoned[0] as { agent: string; activation: string }).activation;
		expect(abandoned[0]).toMatchObject({ agent: 'assistant' });
		expect(parseId(givenUp)).toMatchObject({ cause: 'close', seat: 'assistant', attempt: 4 });
		const stored = await storedOf(runtime.sessions, session.name);
		expect(
			stored
				.filter((entry) => (entry.data as LeaseChange).id === givenUp)
				.map((entry) => entry.data),
		).toMatchObject([{ phase: 'ended', reason: 'abandoned' }]);
		// nothing is owed, no summary was written, and the record stands whole
		expect((await session.messages()).filter(isSummary)).toHaveLength(0);
		await clock.advance(600_000);
		await session.quiet();
		expect(events.filter((e) => e.type === 'abandoned')).toHaveLength(1);
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

	it('answers a question that landed between its last renewal and its release', async () => {
		// The activation renewed, saw the record had not moved, and released. A
		// question that lands while the release is on the wire reached no
		// activation: the released lease heard through its renewal, so the
		// question is pending for the seat, and the seat is woken for it.
		let visit: Visit | undefined;
		const releases = (l: unknown) => (l as { phase: string }).phase === 'ended';
		const faults: Fault[] = [
			{
				on: 'lease',
				kind: 'hold',
				match: releases,
				hold: async () => {
					await visit?.deliver({ text: 'Second?' });
				},
			},
		];
		const { session } = open(faults, byAgent({ solo: answersEveryQuestion(['andrei']) }));
		visit = await enter(session);
		await visit.deliver({ text: 'First?' });
		await session.quiet();
		expect((await session.messages()).filter(isSpoken).map((m) => m.text)).toEqual([
			'First?',
			'solo on First?',
			'Second?',
			'solo on Second?',
		]);
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

describe('a lease judged where its change is written', () => {
	const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

	it('keeps a lease whose renewal landed ahead of the expiry the alarm decided', async () => {
		const clock = fakeClock();
		const base = await memory.open();
		const gate = deferred();
		let runningRows = 0;
		// the claim lands at once; the first renewal is held on the storage
		const sessions = gatedOpener(base.sessions, (type, data) => {
			const entry = data as LeaseChange;
			if (
				type !== 'ambion/lease' ||
				entry.phase !== 'running' ||
				parseId(entry.id)?.seat !== 'solo'
			) {
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
		// half the expiry: the renewal is asked for, and its change waits on the storage
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
		const stored = (await storedOf(base.sessions, session.name))
			.filter((r) => r.type === 'ambion/lease')
			.map((r) => r.data as LeaseChange)
			.filter((l) => parseId(l.id)?.seat === 'solo');
		// the claim, the renewal, the check at the run's end, and one release: no expiry
		expect(stored.filter((l) => l.phase === 'ended').map((l) => l.reason)).toEqual(['released']);
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
						match: (id) => {
							const parsed = typeof id === 'string' ? parseId(id) : undefined;
							return parsed?.cause === 'close' && parsed.attempt === 2;
						},
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
		expect(summaries[0]?.covers.through).toBe(messageBefore(record, summaries[0]?.seq ?? 0));
	});
});
