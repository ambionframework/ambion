/**
 * A wake is safe to send twice, a lost one is sent again, a lost release
 * expires, and a lost wake into a running activation is read off the
 * record. Rule 4 of the design:
 * every activation's id is derived from the journal, so nothing that crosses
 * the wire has to arrive exactly once.
 */
import type { Context } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeActivationId } from '../src/activation-id.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	startRoom,
	type Visit,
} from '../src/index.ts';
import type { LeaseChange } from '../src/journal/events.ts';
import { inProcessTransport, type SeatRoom } from '../src/transport.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import {
	assistant,
	assistantEnded,
	collect,
	currentExchange,
	deferred,
	enter,
	messagesOf,
	participantsOf,
	roomName,
	storedOf,
	tick,
	waitForRoom,
} from './support/room.ts';
import {
	answersEveryQuestion,
	byAgent,
	contextText,
	isClosing,
	quiet,
	type Script,
	says,
	scripted,
	speak,
	summarise,
} from './support/scripted.ts';
import { gatedJournals, memory } from './support/storage.ts';
import { type Fault, faultyTransport } from './support/transport.ts';

const solo = defineAgent({
	name: 'solo',
	identity: 'Speaks once.',
	instructions: 'speak',
	model: 'scripted/solo',
});

const started: Room[] = [];
afterEach(async () => {
	for (const session of started.splice(0)) await session.stop();
});

async function open(
	faults: Fault[],
	script: Script,
	wake?: { expiry: number; deadline: number },
	summary = false,
): Promise<{ session: Room; clock: FakeClock; runtime: Runtime }> {
	const clock = fakeClock();
	const runtime = createRuntime({
		clock,
		transport: faultyTransport(inProcessTransport(), faults, clock),
		...(wake === undefined ? {} : { wake }),
	});
	const session = await startRoom({
		name: roomName('lease'),
		...(summary ? { summary: assistant.name } : {}),
		seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
		agents: [solo, assistant],
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
		const { session, clock } = await open([{ on: 'wake', kind: 'drop' }], (_c, _a, call) =>
			call === 1 ? speak('hi') : quiet(),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'say hi' });
		await tick();
		expect(starts(events)).toBe(0);

		await clock.advance(4_999);
		expect(starts(events)).toBe(0);
		await clock.advance(1);
		await waitForRoom(session);
		expect(starts(events)).toBe(1);
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
	});

	it('runs one activation for a duplicated wake', async () => {
		const { session } = await open([{ on: 'wake', kind: 'duplicate' }], (_c, _a, call) =>
			call === 1 ? speak('hi') : quiet(),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'say hi' });
		await waitForRoom(session);
		expect(starts(events)).toBe(1);
		expect((await messagesOf(session)).filter(isSpoken)).toHaveLength(2);
	});

	it('expires a lease whose release was lost twice, and answers the late release stale', async () => {
		// a release the seat never heard back on is asked again once, so both are lost
		const ended = (l: unknown) => (l as { operation: string }).operation === 'release';
		const { session, clock } = await open(
			[
				{ on: 'lease', kind: 'drop', match: ended },
				{ on: 'lease', kind: 'drop', match: ended },
			],
			(_c, _a, call) => (call === 1 ? speak('hi') : quiet()),
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'say hi' });
		await tick();
		await tick();
		// the seat spoke, its release was lost, and the room still holds the lease
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.from)).toContain('solo');
		expect(events.some((e) => e.type === 'activation_end')).toBe(false);
		expect(await currentExchange(session)).toBeDefined();

		await clock.advance(60_000);
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		// the expired lease answers nothing, whatever it said: the seat is woken again
		// after the backoff, reads its own words on the record, and stands down
		expect(await currentExchange(session)).toBeDefined();
		await clock.advance(30_000);
		await waitForRoom(session);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(2);
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
		expect(await currentExchange(session)).toBeUndefined();

		const room = session as unknown as SeatRoom;
		await expect(
			room.lease({
				activation: 'message:2:solo:1',
				operation: 'release',
				reason: 'released',
				readThrough: 0,
			}),
		).resolves.toEqual({
			stale: 'the lease ended',
		});
	});

	it('expires an activation at its deadline, cuts it, and wakes the seat again after the backoff', async () => {
		const held = deferred();
		const { session, clock, runtime } = await open(
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
		await visit.send({ text: 'take your time' });
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
		const stored = await storedOf(runtime.journals, session.name);
		const renewals = stored.flatMap((entry) => {
			const lease = entry.body as LeaseChange;
			const mine = entry.kind === 'lease' && decodeActivationId(lease.id)?.seat === 'solo';
			return mine && lease.phase === 'running' ? [lease.expiresAt] : [];
		});
		// the room wrote a claim and renewals, and no change takes the lease past the deadline
		expect(renewals.length).toBeGreaterThan(1);
		expect(renewals.every((expiry) => expiry <= clock.now())).toBe(true);

		// the activation came to nothing, so the seat is woken again after the backoff
		expect(await currentExchange(session)).toBeDefined();
		await clock.advance(30_000);
		await waitForRoom(session);
		expect(starts(events)).toBe(2);
		expect(await currentExchange(session)).toBeUndefined();
		held.resolve();
	});

	it('gives up on a wake at the cap, writes the attempt it does not make, and closes', async () => {
		const { session, clock, runtime } = await open([], () => {
			throw new Error('the model failed');
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'answer me' });
		await tick();
		// the first attempt failed; the second and the third fail after their backoffs
		await clock.advance(30_000);
		await clock.advance(60_000);
		await waitForRoom(session);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(3);

		// the room gives up: the attempt it does not make is on the record, once
		expect(events.filter((e) => e.type === 'abandoned')).toEqual([
			{ type: 'abandoned', agent: 'solo', activation: 'message:4:solo:4', cause: 'transient' },
		]);
		const stored = await storedOf(runtime.journals, session.name);
		const gaveUp = stored.filter((entry) => {
			const lease = entry.body as LeaseChange;
			return entry.kind === 'lease' && lease.phase === 'ended' && lease.reason === 'abandoned';
		});
		expect(gaveUp.map((entry) => (entry.body as LeaseChange).id)).toEqual(['message:4:solo:4']);

		// the wake is answered, so the exchange closes and the seat stands idle
		expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
		expect(await currentExchange(session)).toBeUndefined();
		expect((await participantsOf(session)).find((s) => s.name === 'solo')).toMatchObject({
			status: 'idle',
		});
		// and the room stays that way: no fourth attempt starts, whatever the clock does
		await clock.advance(600_000);
		await waitForRoom(session);
		expect(starts(events)).toBe(3);
	});

	it('gives up on a summary at the cap, and the range stays whole for every reader', async () => {
		const { session, clock, runtime } = await open(
			[],
			byAgent({
				solo: says(['I answered.', 'And again.']),
				assistant: (context) => {
					if (!isClosing(context)) return quiet();
					throw new Error('the model failed');
				},
			}),
			undefined,
			true,
		);
		const events = collect(session);
		const drafted = assistantEnded(session);
		const visit = await enter(session);
		await visit.send({ text: 'answer me' });
		// a room that owes a draft is not quiet, so the failed attempt is the wait
		await drafted;
		// the close owes a summary, and the first draft failed
		expect(events.some((e) => e.type === 'exchange_closed')).toBe(true);
		await clock.advance(30_000);
		await clock.advance(60_000);
		await waitForRoom(session);
		expect(events.filter((e) => e.type === 'error')).toHaveLength(3);

		// the room gives up on the summary, and says so once
		const abandoned = events.filter((e) => e.type === 'abandoned');
		expect(abandoned).toHaveLength(1);
		const givenUp = (abandoned[0] as { agent: string; activation: string }).activation;
		expect(abandoned[0]).toMatchObject({ agent: 'assistant' });
		expect(decodeActivationId(givenUp)).toMatchObject({
			source: 'closed',
			seat: 'assistant',
			attempt: 4,
		});
		const stored = await storedOf(runtime.journals, session.name);
		expect(
			stored
				.filter((entry) => (entry.body as LeaseChange).id === givenUp)
				.map((entry) => entry.body),
		).toMatchObject([{ phase: 'ended', reason: 'abandoned' }]);
		// nothing is owed, no summary was written, and the record stands whole
		expect((await messagesOf(session)).filter(isSummary)).toHaveLength(0);
		await clock.advance(600_000);
		await waitForRoom(session);
		expect(events.filter((e) => e.type === 'abandoned')).toHaveLength(1);
	});

	it('refuses a commit from an activation whose renewals were lost past the expiry', async () => {
		const held = deferred();
		// the claim goes through; the one renewal before the expiry is lost
		const renewals = (l: unknown) => (l as { operation: string }).operation === 'renew';
		const faults: Fault[] = [{ on: 'lease', kind: 'drop', match: renewals }];
		const { session, clock } = await open(faults, async (_c, _a, call) => {
			if (call !== 1) return quiet();
			await held.promise;
			return speak('too late');
		});
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'go' });
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
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.from)).toEqual(['andrei']);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		// a lease that expired without a word answers nothing: the exchange stays
		// open, and the seat is woken again after the backoff
		expect(await currentExchange(session)).toMatchObject({ owner: 'andrei' });
		expect(starts(events)).toBe(1);
		await clock.advance(30_000);
		await waitForRoom(session);
		expect(starts(events)).toBe(2);
		expect(await currentExchange(session)).toBeUndefined();
	});

	it('answers a question that landed between its last renewal and its release', async () => {
		// The activation renewed, saw the record had not moved, and released. A
		// question that lands while the release is on the wire reached no
		// activation: the released lease heard through its renewal, so the
		// question is pending for the seat, and the seat is woken for it.
		let visit: Visit | undefined;
		const releases = (l: unknown) => (l as { operation: string }).operation === 'release';
		const faults: Fault[] = [
			{
				on: 'lease',
				kind: 'hold',
				match: releases,
				hold: async () => {
					await visit?.send({ text: 'Second?' });
				},
			},
		];
		const { session } = await open(faults, byAgent({ solo: answersEveryQuestion(['andrei']) }));
		visit = await enter(session);
		await visit.send({ text: 'First?' });
		await waitForRoom(session);
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.text)).toEqual([
			'First?',
			'solo on First?',
			'Second?',
			'solo on Second?',
		]);
		expect(await currentExchange(session)).toBeUndefined();
	});

	it('rebuilds the activation when a wake into it was lost, and reads the message off the record', async () => {
		const held = deferred();
		const contexts: string[] = [];
		// the first wake starts the activation; the second, the steer into it, is lost
		const { session } = await open(
			[{ on: 'wake', kind: 'drop', skip: 1 }],
			async (context, _a, call) => {
				contexts.push(contextText(context as Context));
				if (call === 1) await held.promise;
				return quiet();
			},
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'first' });
		await tick();
		await visit.send({ text: 'second' });
		held.resolve();
		await waitForRoom(session);

		expect(starts(events)).toBe(1);
		expect(contexts).toHaveLength(2);
		expect(contexts[0]).not.toContain('second');
		expect(contexts[1]).toContain('second');
	});
});

describe('a lease judged where its change is written', () => {
	const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

	it('keeps a remote renewal while retrying a locally expired execution', async () => {
		const clock = fakeClock();
		const base = await memory.open();
		const gate = deferred();
		let runningRows = 0;
		// the claim lands at once; the first renewal is held on the storage
		const journals = gatedJournals(base.storage, (type, data) => {
			const entry = (data as { body: LeaseChange }).body;
			if (
				type !== 'lease' ||
				entry.phase !== 'running' ||
				decodeActivationId(entry.id)?.seat !== 'solo'
			) {
				return undefined;
			}
			runningRows += 1;
			return runningRows === 2 ? gate.promise : undefined;
		});
		const held = deferred();
		const session = await startRoom({
			name: roomName('lease-renewal'),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			runtime: createRuntime({ clock, storage: journals }),
			streamFn: scripted(async (_c, _a, call) => {
				if (call === 1) {
					await held.promise;
					return speak('late but alive');
				}
				return call === 2 ? speak('recovered after expiry') : quiet();
			}),
		});
		started.push(session);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'go' });
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
		// The accepted renewal holds the remote lease to 90s; its expiry then
		// schedules the retry after the 30s backoff, at 120s.
		await clock.advance(60_000);
		await waitForRoom(session);
		expect((await messagesOf(session)).filter(isSpoken).map((m) => m.from)).toEqual([
			'andrei',
			'solo',
		]);
		const stored = (await storedOf(base.journals, session.name))
			.filter((r) => r.kind === 'lease')
			.map((r) => r.body as LeaseChange)
			.filter((l) => decodeActivationId(l.id)?.seat === 'solo');
		// The local expiry releases as a failed attempt; the room's accepted
		// renewal keeps authority until its later expiry, which creates the retry.
		expect(stored.filter((l) => l.phase === 'ended').map((l) => l.reason)).toEqual([
			'expired',
			'released',
		]);
	});

	it('keeps a pending summary for each close when another exchange ends during its claim', async () => {
		const clock = fakeClock();
		const opened = await memory.open();
		// the view of the second attempt at the draft is delayed on the wire
		const runtime = createRuntime({
			clock,
			storage: opened.storage,
			call: { timeout: 20_000 },
			transport: faultyTransport(
				inProcessTransport(),
				[
					{
						on: 'view',
						kind: 'delay',
						ms: 10_000,
						match: (id) => {
							const parsed = typeof id === 'string' ? decodeActivationId(id) : undefined;
							return parsed?.source === 'closed' && parsed.attempt === 2;
						},
					},
				],
				clock,
			),
		});
		const held = deferred();
		const session = await startRoom({
			name: roomName('lease-draft'),
			summary: assistant.name,
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
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
						if (!isClosing(context)) return quiet();
						if (call === 1) throw new Error('the model failed');
						return summarise('The one message.');
					},
				}),
			),
		});
		started.push(session);
		const events = collect(session);
		const visit = await session.visit(priya);
		const drafted = assistantEnded(session);
		await visit.send({ text: 'First?' });
		// a room that owes a draft is not quiet, so the failed attempt is the wait
		await drafted;
		expect((await messagesOf(session)).filter(isSummary)).toHaveLength(0);

		// the seat works on the second exchange when the backoff passes and the draft is claimed
		await visit.send({ text: 'Second?' });
		await tick();
		await tick();
		await clock.advance(30_000);
		expect((await participantsOf(session)).find((s) => s.name === 'assistant')).toMatchObject({
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
		await waitForRoom(session);
		await clock.advance(200_000);
		await waitForRoom(session);

		const record = await messagesOf(session);
		const questions = record.filter((m) => isSpoken(m) && m.from === 'priya');
		const summaries = record.filter(isSummary);
		expect(summaries).toHaveLength(2);
		expect(summaries.map((summary) => summary.covers.from)).toEqual(
			questions.map((question) => question.seq),
		);
		const second = questions[1];
		expect(second).toBeDefined();
		if (second === undefined) throw new Error('Expected the second close.');
		expect(summaries[0]?.covers.through).toBeLessThan(second.seq);
		expect(summaries[1]?.covers.from).toBe(questions[1]?.seq);
		const closes = events.filter((event) => event.type === 'exchange_closed');
		for (const summary of summaries) {
			const close = closes.find((event) => event.exchange.from === summary.covers.from);
			expect(close).toBeDefined();
			if (close === undefined) throw new Error('Expected the recorded close.');
			expect(summary.covers).toEqual({
				from: close.exchange.from,
				through: close.exchange.through,
			});
		}
	});
});
