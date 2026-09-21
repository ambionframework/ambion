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
import { piExecution } from '../../pi/src/index.ts';
import { runningRoom } from '../src/host/runtime.ts';
import { inProcessTransport } from '../src/hosting.ts';
import { createRuntime, resumeRoom, startRoom } from '../src/index.ts';
import { fakeClock } from '../src/testing.ts';
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
import { collect, messagesOf, roomName, waitForRoom } from './support/room.ts';
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
		await world.room.stop();
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
					await world.room.stop();
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
				storage: opened.storage,
				clock,
				transport: serializing(inProcessTransport()),
			});
		const first = host();
		const name = roomName('split');
		const room = await startRoom({
			name,
			runtime: first,
			summary: assistant.name,
			seats: {
				[product.name]: 'broadcast',
				[colleague.name]: 'broadcast',
				[assistant.name]: 'none',
			},
			agents: [product, colleague, assistant],
			execution: piExecution({ stream: scripted(script) }),
		});
		const events = collect(room);
		const hers = await room.visit(priya);
		await hers.send({ text: 'First?', key: 'q1' });
		await waitForRoom(room);
		// the second host takes the name while the first is alive and keeps taking questions
		const second = host();
		const taken = await resumeRoom(name, {
			runtime: second,
			agents,
			execution: piExecution({ stream: scripted(script) }),
		});
		const his = await taken.visit(sam);
		await his.send({ text: 'Second?', key: 'q2' });
		await waitForRoom(taken);
		// the first host's next write finds the fence: it is superseded, and writes nothing
		await expect(hers.send({ text: 'Third?', key: 'q3' })).rejects.toThrow(/superseded/);
		await waitForRoom(room);
		try {
			expect(events.some((e) => e.type === 'superseded')).toBe(true);
			expect(runningRoom(first, name)).toBeUndefined();
			const record = await messagesOf(taken);
			expect(record.map((m) => m.key)).toContain('q2');
			expect(record.map((m) => m.key)).not.toContain('q3');
			expect(new Set(record.map((m) => m.seq)).size).toBe(record.length);
			// and a third host reads the same record off the storage, and fences the second out
			const third = await resumeRoom(name, {
				runtime: host(),
				agents,
				execution: piExecution({ stream: scripted(script) }),
			});
			expect((await messagesOf(third)).map((m) => m.seq)).toEqual(record.map((m) => m.seq));
			await third.stop();
			// the second host learns at its next write: its stop finds the fence, says so, and frees the name
			const taken_events = collect(taken);
			await taken.stop();
			expect(taken_events.some((e) => e.type === 'superseded')).toBe(true);
			expect(runningRoom(second, name)).toBeUndefined();
		} finally {
			await opened.dispose();
		}
	});
});
