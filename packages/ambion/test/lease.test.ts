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
	inProcessTransport,
	isSpoken,
	type Runtime,
	type SeatRoom,
	type Session,
	startSession,
	stopSession,
} from '../src/index.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { assistant, collect, deferred, enter, roomName, rowsOf, tick } from './support/room.ts';
import { contextText, quiet, type Script, scripted, speak } from './support/scripted.ts';
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
	wake: Partial<Runtime['wake']> = {},
): { session: Session; clock: FakeClock } {
	const clock = fakeClock();
	const runtime = createRuntime({
		clock,
		wake,
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
		// the activation came to nothing, so the room wakes the seat again after the backoff
		expect(session.exchange()).toBeDefined();
		await clock.advance(30_000);
		await session.quiet();
		expect(starts(events)).toBe(2);
		expect(session.exchange()).toBeUndefined();
	});

	it('expires an activation at its deadline, cuts it, and wakes the seat again after the backoff', async () => {
		const held = deferred();
		const { session, clock } = open(
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

		// the lease is renewed up to the deadline and no further; at the deadline the room expires it
		await clock.advance(119_999);
		expect(events.some((e) => e.type === 'error')).toBe(false);
		await clock.advance(1);
		expect(events.some((e) => e.type === 'error' && /past its lease/.test(e.error.message))).toBe(
			true,
		);
		expect(events.filter((e) => e.type === 'activation_end')).toHaveLength(1);
		const runtime = (session as unknown as { runtime: Runtime }).runtime;
		const rows = (await rowsOf(runtime.sessions, session.name)).filter(
			(row) => row.type === 'ambion/lease',
		);
		const renewals = rows.filter(
			(row) =>
				(row.data as { id: string; phase: string }).id === '2:solo' &&
				(row.data as { phase: string }).phase === 'running',
		);
		// a claim and three renewals: the one that reached the deadline moved the expiry nowhere
		expect(renewals.length).toBeLessThanOrEqual(4);
		expect(renewals.every((row) => (row.data as { expiry: number }).expiry <= clock.now())).toBe(
			true,
		);

		// the activation came to nothing, so the seat is woken again after the backoff
		expect(session.exchange()).toBeDefined();
		await clock.advance(30_000);
		await session.quiet();
		expect(starts(events)).toBe(2);
		expect(session.exchange()).toBeUndefined();
		held.resolve();
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
