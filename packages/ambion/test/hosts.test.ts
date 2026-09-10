/**
 * Two hosts over one log. A handover: the host that runs the room dies
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
import { roomName, rowsOf } from './support/room.ts';
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

describe('a split: two live hosts over one log', () => {
	// The design forbids it: two live rooms over one record each append to it and
	// diverge. Nothing fences the first host out yet, so this test fails: both hosts
	// assign the same seqs, and a later reader folds a record with a seq twice.
	it.fails(
		'the second host fences the first out, and the record holds every seq once',
		async () => {
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
			const hers = await visitSession(room, priya);
			await hers.deliver({ text: 'First?', key: 'q1' });
			await room.quiet();
			// the second host takes the name while the first is alive and keeps taking questions
			const second = host();
			const taken = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
			const his = await visitSession(taken, sam);
			await his.deliver({ text: 'Second?', key: 'q2' });
			await taken.quiet();
			await hers.deliver({ text: 'Third?', key: 'q3' });
			await room.quiet();
			const seqs = (await rowsOf(opened.sessions, name)).flatMap((r) =>
				r.type === 'ambion/message' ? [(r.data as { seq: number }).seq] : [],
			);
			try {
				expect(new Set(seqs).size, `seqs on the storage: ${seqs.join(' ')}`).toBe(seqs.length);
			} finally {
				await stopSession(room);
				await stopSession(taken);
				await opened.dispose();
			}
		},
	);
});
