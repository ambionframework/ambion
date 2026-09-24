/**
 * A wake is safe to send twice, a lost one is sent again, a lost release
 * expires, and a lost wake into a running activation is read off the
 * record. The design says:
 * every activation's id is derived from the journal, so nothing that crosses
 * the wire has to arrive exactly once.
 */
import type { Context } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { decodeActivationId } from '../src/activation-id.ts';
import { hostingOf, inProcessTransport, type RoomProtocol } from '../src/hosting.ts';
import {
	type CreateRuntimeOptions,
	createRuntime,
	defineHuman,
	isSpoken,
	isSummary,
	type Room,
	type Runtime,
	startRoom,
	type Visit,
} from '../src/index.ts';
import type { LeaseChange } from '../src/journal/events.ts';
import { type FakeClock, fakeClock } from '../src/testing.ts';
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
	scriptedAgent,
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
import { stopAtEnd } from './support/stop.ts';
import { gatedJournals, memory } from './support/storage.ts';
import { type Fault, faultyTransport } from './support/transport.ts';

const solo = scriptedAgent('solo', 'Speaks once.');
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

interface Options {
	faults?: Fault[];
	limits?: CreateRuntimeOptions['limits'];
	summary?: boolean;
	/** A runtime of the test's own on the clock, in place of the faulty transport. */
	runtime?: (clock: FakeClock) => Runtime;
}

async function open(
	script: Script,
	{ faults = [], limits, summary = false, runtime: own }: Options = {},
): Promise<{ session: Room; clock: FakeClock; runtime: Runtime }> {
	const clock = fakeClock();
	const runtime =
		own?.(clock) ??
		createRuntime({
			clock,
			transport: faultyTransport(inProcessTransport(), faults, clock),
			...(limits === undefined ? {} : { limits }),
		});
	const session = stopAtEnd(
		await startRoom({
			name: roomName('lease'),
			...(summary ? { summary: assistant.name } : {}),
			seats: { [solo.name]: 'broadcast', [assistant.name]: 'none' },
			agents: [solo, assistant],
			runtime,
			execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
		}),
	);
	return { session, clock, runtime };
}

const speaksOnce: Script = (_c, _a, call) => (call === 1 ? speak('hi') : quiet());
const starts = (events: ReturnType<typeof collect>) =>
	events.filter((e) => e.type === 'activation_start').length;
const ends = (events: ReturnType<typeof collect>) =>
	events.filter((e) => e.type === 'activation_end').length;
const expired = (events: ReturnType<typeof collect>) =>
	events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message));
const speakers = async (session: Room) =>
	(await messagesOf(session)).filter(isSpoken).map((m) => m.from);
const leaseChanges = async (runtime: Runtime, session: Room) =>
	(await storedOf(hostingOf(runtime).journals, session.name)).flatMap((entry) =>
		entry.kind === 'lease' ? [entry.body as LeaseChange] : [],
	);
const operation = (name: string) => (l: unknown) => (l as { operation: string }).operation === name;

describe('a lease', () => {
	it('sends a dropped wake again after the resend window, and the seat runs once', async () => {
		const { session, clock } = await open(speaksOnce, { faults: [{ on: 'wake', kind: 'drop' }] });
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
		expect(await speakers(session)).toEqual(['andrei', 'solo']);
	});

	it('runs one activation for a duplicated wake', async () => {
		const { session } = await open(speaksOnce, { faults: [{ on: 'wake', kind: 'duplicate' }] });
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'say hi' });
		await waitForRoom(session);
		expect(starts(events)).toBe(1);
		expect(await speakers(session)).toHaveLength(2);
	});

	it('expires a lease whose release was lost twice, and answers the late release stale', async () => {
		// a release the seat never heard back on is asked again once, so both are lost
		const lost: Fault = { on: 'lease', kind: 'drop', match: operation('release') };
		const { session, clock } = await open(speaksOnce, { faults: [lost, { ...lost }] });
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'say hi' });
		await tick();
		await tick();
		// the seat spoke, its release was lost, and the room still holds the lease
		expect(await speakers(session)).toContain('solo');
		expect(ends(events)).toBe(0);
		expect(await currentExchange(session)).toBeDefined();

		await clock.advance(60_000);
		expect(expired(events)).toBe(true);
		expect(ends(events)).toBe(1);
		// the expired lease answers nothing, whatever it said: the seat is woken again
		// after the backoff, reads its own words on the record, and stands down
		expect(await currentExchange(session)).toBeDefined();
		await clock.advance(30_000);
		await waitForRoom(session);
		expect(ends(events)).toBe(2);
		expect(await speakers(session)).toEqual(['andrei', 'solo']);
		expect(await currentExchange(session)).toBeUndefined();

		const room = session as unknown as RoomProtocol;
		await expect(
			room.lease({
				activation: 'message:2:solo:1',
				operation: 'release',
				reason: 'released',
				readThrough: 0,
			}),
		).resolves.toEqual({ stale: 'the lease ended' });
	});

	it('expires an activation at its deadline, cuts it, and wakes the seat again after the backoff', async () => {
		const held = deferred();
		const { session, clock, runtime } = await open(
			async (_c, _a, call) => {
				if (call === 1) await held.promise;
				return quiet();
			},
			{ limits: { lease: { ttl: 60_000, deadline: 120_000 } } },
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
		expect(expired(events)).toBe(true);
		expect(ends(events)).toBe(1);
		const renewals = (await leaseChanges(runtime, session)).flatMap((lease) =>
			decodeActivationId(lease.id)?.seat === 'solo' && lease.phase === 'running'
				? [lease.expiresAt]
				: [],
		);
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
		const { session, clock, runtime } = await open(() => {
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
		const gaveUp = (await leaseChanges(runtime, session)).filter(
			(lease) => lease.phase === 'ended' && lease.reason === 'abandoned',
		);
		expect(gaveUp.map((lease) => lease.id)).toEqual(['message:4:solo:4']);

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
			byAgent({
				solo: says(['I answered.', 'And again.']),
				assistant: (context) => {
					if (!isClosing(context)) return quiet();
					throw new Error('the model failed');
				},
			}),
			{ summary: true },
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
		expect(
			(await leaseChanges(runtime, session)).filter((lease) => lease.id === givenUp),
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
		const { session, clock } = await open(
			async (_c, _a, call) => {
				if (call !== 1) return quiet();
				await held.promise;
				return speak('too late');
			},
			{ faults: [{ on: 'lease', kind: 'drop', match: operation('renew') }] },
		);
		const events = collect(session);
		const visit = await enter(session);
		await visit.send({ text: 'go' });
		await tick();
		expect(starts(events)).toBe(1);

		// half the expiry: the renewal is lost; the whole expiry: the lease ends
		await clock.advance(60_000);
		expect(expired(events)).toBe(true);
		held.resolve();
		await tick();
		await tick();
		// the say arrived under a lease that ended, so nothing landed
		expect(await speakers(session)).toEqual(['andrei']);
		expect(ends(events)).toBe(1);
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
		const { session } = await open(byAgent({ solo: answersEveryQuestion(['andrei']) }), {
			faults: [
				{
					on: 'lease',
					kind: 'hold',
					match: operation('release'),
					hold: async () => {
						await visit?.send({ text: 'Second?' });
					},
				},
			],
		});
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
			async (context, _a, call) => {
				contexts.push(contextText(context as Context));
				if (call === 1) await held.promise;
				return quiet();
			},
			{ faults: [{ on: 'wake', kind: 'drop', skip: 1 }] },
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
	it('keeps a remote renewal while retrying a locally expired execution', async () => {
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
		const { session, clock, runtime } = await open(
			async (_c, _a, call) => {
				if (call === 1) {
					await held.promise;
					return speak('late but alive');
				}
				return call === 2 ? speak('recovered after expiry') : quiet();
			},
			{ runtime: (clock) => createRuntime({ clock, storage: journals }) },
		);
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
		expect(await speakers(session)).toEqual(['andrei', 'solo']);
		const reasons = (await leaseChanges(runtime, session)).flatMap((l) =>
			decodeActivationId(l.id)?.seat === 'solo' && l.phase === 'ended' ? [l.reason] : [],
		);
		// The local expiry releases as a failed attempt; the room's accepted
		// renewal keeps authority until its later expiry, which creates the retry.
		expect(reasons).toEqual(['expired', 'released']);
	});

	it('keeps a pending summary for each close when another exchange ends during its claim', async () => {
		const held = deferred();
		// the view of the second attempt at the draft is delayed on the wire
		const delayed: Fault = {
			on: 'view',
			kind: 'delay',
			ms: 10_000,
			match: (id) => {
				const parsed = typeof id === 'string' ? decodeActivationId(id) : undefined;
				return parsed?.source === 'closed' && parsed.attempt === 2;
			},
		};
		const { session, clock } = await open(
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
			{ faults: [delayed], limits: { call: { timeout: 20_000 } }, summary: true },
		);
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
