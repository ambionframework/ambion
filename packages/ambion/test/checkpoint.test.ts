/**
 * A checkpoint stands for every row before it. The fold over a log the
 * room compacted equals the fold over every row the storage holds, and a
 * checkpoint the room cannot read changes nothing.
 */
import { describe, expect, it } from 'vitest';
import { foldRoom, type RoomState } from '../src/fold.ts';
import {
	createRuntime,
	defineAgent,
	defineHuman,
	isSummary,
	readSession,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { isLive } from '../src/lease.ts';
import { type LogEntry, RoomLog } from '../src/log.ts';
import { fakeClock } from './support/clock.ts';
import { roomName, rowsOf } from './support/room.ts';
import { byAgent, quiet, scripted, speak, summarise, toolNames } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes the one message a person reads.',
	instructions: 'Answer what was asked, once.',
	model: 'scripted/assistant',
});
const alpha = defineAgent({
	name: 'alpha',
	identity: 'Alpha.',
	instructions: 'x',
	model: 'scripted/alpha',
});
const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

/** Alpha answers every question twice; the assistant writes once per close. */
const script = byAgent({
	alpha: (_context, _name, call) => (call % 3 === 0 ? quiet() : speak(`answer ${call}`)),
	assistant: (context, _name, call) =>
		toolNames(context).includes('summarise') && call % 2 === 1
			? summarise(`message ${call}`)
			: quiet(),
});

/** Every row the storage holds, as the entries a fold reads, with no checkpoint among them. */
async function raw(sessions: Parameters<typeof rowsOf>[0], name: string): Promise<LogEntry[]> {
	const rows = await rowsOf(sessions, name);
	return rows.flatMap((row): LogEntry[] => {
		const type = row.type.slice('ambion/'.length);
		if (type === 'checkpoint') return [];
		return [{ type, [type]: row.data } as LogEntry];
	});
}

/** What a fold says, in the shape two folds are compared by. */
function shape(state: RoomState, now: number) {
	return {
		roster: state.roster,
		reserve: state.reserve,
		people: [...state.people],
		exchange: state.exchange,
		pending: state.pending,
		owed: state.owed,
		lastSeq: state.lastSeq,
		lastClose: state.closes.at(-1),
		live: [...state.leases.values()]
			.filter((lease) => isLive(lease, now))
			.map((lease) => lease.id)
			.sort(),
	};
}

describe.each(storages)('a checkpoint on $name', (storage) => {
	it('stands for every row before it, and the fold over the compacted log is the fold over the whole', async () => {
		const opened = await storage.open();
		try {
			const clock = fakeClock();
			const runtime = createRuntime({
				sessions: opened.sessions,
				clock,
				agents: [assistant, alpha],
				checkpoint: { rows: 3 },
			});
			const name = roomName(`checkpoint-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			for (const question of ['First?', 'Second?', 'Third?']) {
				await visit.deliver({ text: question });
				await session.quiet();
			}
			expect((await session.messages()).filter(isSummary)).toHaveLength(3);
			await stopSession(session);

			const rows = await rowsOf(opened.sessions, name);
			expect(rows.filter((row) => row.type === 'ambion/checkpoint').length).toBeGreaterThan(0);
			const whole = await raw(opened.sessions, name);
			const log = new RoomLog(opened.sessions.open(name));
			await log.ready;
			// the compacted log holds the messages, the checkpoint, and the rows since it
			const compacted = log.entries.filter((entry) => entry.type !== 'message');
			expect(compacted.length).toBeLessThan(
				whole.filter((entry) => entry.type !== 'message').length,
			);
			expect(log.entries.filter((entry) => entry.type === 'message')).toEqual(
				whole.filter((entry) => entry.type === 'message'),
			);
			const options = runtime.retry;
			expect(shape(foldRoom(log.entries, options), clock.now())).toEqual(
				shape(foldRoom(whole, options), clock.now()),
			);
			expect(foldRoom(log.entries, options).floor).toBeGreaterThan(0);
		} finally {
			await opened.dispose();
		}
	});

	it('ignores a checkpoint it cannot read', async () => {
		const opened = await storage.open();
		try {
			const clock = fakeClock();
			const runtime = createRuntime({
				sessions: opened.sessions,
				clock,
				agents: [assistant, alpha],
			});
			const name = roomName(`checkpoint-${storage.name}`);
			const session = startSession({
				name,
				assistant,
				agents: [alpha],
				runtime,
				streamFn: scripted(script),
			});
			const visit = await visitSession(session, priya);
			await visit.deliver({ text: 'First?' });
			await session.quiet();
			await stopSession(session);
			const piSession = await opened.sessions.open(name);
			await piSession.appendCustomEntry('ambion/checkpoint', {
				v: 2,
				floor: 1_000,
				leases: 'none',
			});

			const whole = await raw(opened.sessions, name);
			const log = new RoomLog(opened.sessions.open(name));
			await log.ready;
			expect(log.entries.some((entry) => entry.type === 'checkpoint')).toBe(false);
			expect(shape(foldRoom(log.entries, runtime.retry), clock.now())).toEqual(
				shape(foldRoom(whole, runtime.retry), clock.now()),
			);
			const view = readSession(name, { runtime });
			await view.messages();
			expect(view.seats().map((seat) => seat.name)).toEqual(['alpha', 'assistant', 'priya']);
		} finally {
			await opened.dispose();
		}
	});
});
