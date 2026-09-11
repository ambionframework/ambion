/**
 * Two hosts over one journal. A handover: the host that runs the room dies
 * and another resumes the name, while a seat's model fails and is woken
 * again, a seat's say wakes a peer, and people keep asking. A split: the
 * first host is still alive when the second resumes, which the design
 * forbids and nothing enforces yet.
 *
 * `AMBION_CHAOS=all` widens the handover to a crash at every write.
 */
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	inProcessTransport,
	resumeSession,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import {
	agents,
	assistant,
	colleague,
	priya,
	product,
	sam,
	script,
	troubled,
} from './support/cast.ts';
import { World, within } from './support/chaos.ts';
import { fakeClock } from './support/clock.ts';
import { collect, roomName } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { memory } from './support/storage.ts';
import { serializing } from './support/transport.ts';

const full = process.env.AMBION_CHAOS === 'all';

/** The appends the troubled scenario takes untroubled by a crash: the crash points a handover visits. */
async function countWrites(): Promise<number> {
	const opened = await memory.open();
	const world = new World(roomName('hosts-count'), opened, undefined, troubled());
	try {
		await world.run();
		await world.check();
		const writes = world.writes;
		await stopSession(world.room);
		return writes;
	} finally {
		await opened.dispose();
	}
}

const writes = await countWrites();
const every = Array.from({ length: writes }, (_, i) => i + 1);
const points = full ? every : every.filter((at) => at % 3 === 0);

describe('a handover under load', () => {
	describe.each(['before', 'after'] as const)('crashed %s the entry lands', (mode) => {
		it.each(points)(
			`at write %i of ${writes}, the second host wakes the failed seat again and the record ends whole`,
			async (at) => {
				const opened = await memory.open();
				const world = new World(roomName(`hosts-${mode}`), opened, { at, mode }, troubled());
				try {
					await within(world.run(), 20_000, 'the scenario');
					expect(world.crashes).toBe(1);
					await world.check();
					await stopSession(world.room);
				} catch (error) {
					throw new Error(`crash ${mode} write ${at}:\n${await world.describe()}`, {
						cause: error,
					});
				} finally {
					await opened.dispose();
				}
			},
			30_000,
		);
	});
});

describe('a split: two live hosts over one journal', () => {
	// The design forbids it, and the fence holds it: the second host's fence voids
	// the first out. The first host writes nothing more, says so once, and the record
	// the second host serves holds every seq once.
	it('the second host fences the first out, and the record holds every seq once', async () => {
		const opened = await memory.open();
		const clock = fakeClock();
		const host = () =>
			createRuntime({
				sessions: opened.sessions,
				clock,
				agents,
				transport: serializing(inProcessTransport()),
			});
		const first = host();
		const name = roomName('split');
		const room = startSession({
			name,
			runtime: first,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(script),
		});
		const events = collect(room);
		const hers = await visitSession(room, priya);
		await hers.deliver({ text: 'First?', key: 'q1' });
		await room.quiet();
		// the second host takes the name while the first is alive and keeps taking questions
		const second = host();
		const taken = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
		const his = await visitSession(taken, sam);
		await his.deliver({ text: 'Second?', key: 'q2' });
		await taken.quiet();
		// the first host's next write finds the fence: it is superseded, and writes nothing
		await expect(hers.deliver({ text: 'Third?', key: 'q3' })).rejects.toThrow(/superseded/);
		await room.quiet();
		try {
			expect(events.some((e) => e.type === 'superseded')).toBe(true);
			expect(first.running.has(name)).toBe(false);
			const record = await taken.messages();
			expect(record.map((m) => m.key)).toContain('q2');
			expect(record.map((m) => m.key)).not.toContain('q3');
			expect(new Set(record.map((m) => m.seq)).size).toBe(record.length);
			// and a third host reads the same record off the storage, and fences the second out
			const third = await resumeSession(name, { runtime: host(), streamFn: scripted(script) });
			expect((await third.messages()).map((m) => m.seq)).toEqual(record.map((m) => m.seq));
			await stopSession(third);
			// the second host learns at its next write: its stop finds the fence, says so, and frees the name
			const taken_events = collect(taken);
			await stopSession(taken);
			expect(taken_events.some((e) => e.type === 'superseded')).toBe(true);
			expect(second.running.has(name)).toBe(false);
		} finally {
			await opened.dispose();
		}
	});
});
