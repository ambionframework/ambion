/**
 * The split the design forbids, as a history: two live hosts over one
 * journal. The first host stays alive, or is paused (in this process by
 * holding its writes, and in a process of its own with SIGSTOP), while a
 * second host resumes the name. The fence of the second host voids the
 * first: conditional appends refuse every later write of the first host,
 * and the record holds every seq once. A child that uses JSONL for its
 * transcripts keeps the record in the durable journal, and cannot corrupt
 * the record when it continues after the stop.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEntry } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import { runningRoom } from '../src/host/runtime.ts';
import { inProcessTransport } from '../src/hosting.ts';
import { createRuntime, resumeRoom, startRoom } from '../src/index.ts';
import type { Entry as RoomEntry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { fakeClock } from '../src/testing.ts';
import {
	agents,
	assistant,
	colleague,
	priya,
	product,
	questions,
	sam,
	script,
	TIMING,
} from './support/cast.ts';
import { childWrites, openFor, quietNow } from './support/core-failure.ts';
import { History, standing, violations } from './support/history.ts';
import { collect, messagesOf, roomName, storedOf, waitForRoom } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import {
	childJournals,
	childStorage,
	gatedJournals,
	memory,
	type Storage,
	sqlite,
} from './support/storage.ts';
import { stopAtEnd } from './support/stop.ts';
import { serializing } from './support/transport.ts';

const node = process.env.AMBION_NODE ?? process.execPath;

const RETRY = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

/**
 * The stored entries as the fold reads them: the ones that stand past every
 * fence. The storage holds the journal's own three beside the body, so this
 * keeps only the room's record kinds. The native envelope already keeps the
 * body nested beside its seq, key, and run.
 */
function entriesOf(stored: readonly JournalEntry[]): RoomEntry[] {
	return standing(stored).flatMap((entry): RoomEntry[] => {
		if (
			entry.kind !== 'message' &&
			entry.kind !== 'lease' &&
			entry.kind !== 'close' &&
			entry.kind !== 'composition'
		) {
			return [];
		}
		return [entry as RoomEntry];
	});
}

/** A room on its first host, and the hosts that resume it over the same journal. */
async function splitRoom(storage: Storage, gate?: () => Promise<void> | undefined) {
	const opened = await openFor(storage);
	const clock = fakeClock();
	const host = (journals = opened.storage) =>
		createRuntime({ storage: journals, clock, transport: serializing(inProcessTransport()) });
	const first = host(gate === undefined ? undefined : gatedJournals(opened.storage, gate));
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
	const resume = (runtime = host()) =>
		resumeRoom(name, { runtime, agents, execution: piExecution({ stream: scripted(script) }) });
	return { opened, clock, first, name, room, events: collect(room), host, resume };
}

describe.each([memory, sqlite])('a split on $name: two live hosts over one journal', (storage) => {
	it('a paused host that comes back is fenced out before its held write lands', async () => {
		// the first host's writes are held while it is paused; the second host's are not
		let gate: Promise<void> | undefined;
		let release = () => {};
		const { opened, clock, first, name, room, events, resume } = await splitRoom(
			storage,
			() => gate,
		);
		const history = new History(clock);
		const hers = await room.visit(priya);
		await history.run('priya', 'deliver', 'q1', () => hers.send({ text: 'First?', key: 'q1' }));
		await waitForRoom(room);
		// paused: a delivery on the first host is in flight and held
		gate = new Promise((resolve) => {
			release = resolve;
		});
		const held = history.run('priya', 'deliver', 'q2', () =>
			hers.send({ text: 'Second?', key: 'q2' }),
		);
		// the second host takes the name and serves a question
		const taken = stopAtEnd(await resume());
		const his = await taken.visit(sam);
		await history.run('sam', 'deliver', 'q3', () => his.send({ text: 'Third?', key: 'q3' }));
		await waitForRoom(taken);
		// The first host comes back. Its held write sees the newer storage position,
		// so it is refused before the host acknowledges it.
		release();
		await held;
		await history.run('priya', 'deliver', 'q4', () => hers.send({ text: 'Fourth?', key: 'q4' }));
		await waitForRoom(room);
		await history.run(
			'sam',
			'read',
			undefined,
			() => messagesOf(taken),
			(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
		);
		const stored = await storedOf(opened.journals, name);
		const folded = foldRoom(entriesOf(stored), RETRY);
		// The fold read the record. A fold that reads no place answers every
		// check below with nothing, and the checks say the room is whole.
		expect(folded.lastSeq).toBeGreaterThan(0);
		expect(folded.messages.every((message) => message.seq > 0)).toBe(true);
		const record = await messagesOf(taken);
		expect(violations(history, { record, stored, state: folded })).toEqual([]);
		const outcome = (key: string) =>
			history.entries.find((e) => e.key === key && e.phase !== 'invoke');
		expect(outcome('q2')).toMatchObject({ phase: 'fail' });
		expect(outcome('q4')).toMatchObject({ phase: 'fail' });
		expect(events.some((e) => e.type === 'superseded')).toBe(true);
		expect(runningRoom(first, name)).toBeUndefined();
	});

	it('the second host fences the live first out, a third host fences the second, and the record holds every seq once', async () => {
		const { first, name, room, events, host, resume } = await splitRoom(storage);
		const hers = await room.visit(priya);
		await hers.send({ text: 'First?', key: 'q1' });
		await waitForRoom(room);
		// the second host takes the name while the first is alive and keeps taking questions
		const second = host();
		const taken = await resume(second);
		await (await taken.visit(sam)).send({ text: 'Second?', key: 'q2' });
		await waitForRoom(taken);
		// the first host's next write finds the fence: it is superseded, and writes nothing
		await expect(hers.send({ text: 'Third?', key: 'q3' })).rejects.toThrow(/superseded/);
		await waitForRoom(room);
		expect(events.some((e) => e.type === 'superseded')).toBe(true);
		expect(runningRoom(first, name)).toBeUndefined();
		const record = await messagesOf(taken);
		expect(record.map((m) => m.key)).toContain('q2');
		expect(record.map((m) => m.key)).not.toContain('q3');
		expect(new Set(record.map((m) => m.seq)).size).toBe(record.length);
		// and a third host reads the same record off the storage, and fences the second out
		const third = await resume();
		expect((await messagesOf(third)).map((m) => m.seq)).toEqual(record.map((m) => m.seq));
		await third.stop();
		// the second host learns at its next write: its stop finds the fence, says so, and frees the name
		const takenEvents = collect(taken);
		await taken.stop();
		expect(takenEvents.some((e) => e.type === 'superseded')).toBe(true);
		expect(runningRoom(second, name)).toBeUndefined();
	});
});

describe('a split: two live hosts over one SQLite database', () => {
	const child = fileURLToPath(new URL('./support/child.ts', import.meta.url));

	/** Run the child until its journal takes `at` appends, then stop it where it stands. */
	function stopAt(dir: string, name: string, at: number) {
		const args = ['--no-warnings', child, dir, name, '40'];
		const process_ = spawn(node, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		const exited = new Promise<void>((resolve) => process_.on('exit', () => resolve()));
		const stopped = new Promise<number>((resolve, reject) => {
			let sent = false;
			// stopped once, where it stands; what it writes after the continue is its own
			childWrites(process_.stdout, (last) => {
				if (last === 'done' || last < at || sent) return;
				sent = true;
				process_.kill('SIGSTOP');
				resolve(last);
			});
			process_.on('error', reject);
			process_.on('exit', () => reject(new Error('the child ended before the stop')));
		});
		return {
			stopped,
			continue: () => process_.kill('SIGCONT'),
			kill: () => process_.kill('SIGKILL'),
			exited,
		};
	}

	it('a process stopped mid-activation keeps a readable journal after a takeover', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-split-'));
		const name = 'split';
		const paused = stopAt(dir, name, 6);
		try {
			await paused.stopped;
			const journals = childJournals('sqlite', dir);
			const clock = fakeClock(Date.now());
			const runtime = createRuntime({ storage: childStorage('sqlite', dir), clock, ...TIMING });
			const session = await resumeRoom(name, {
				runtime,
				agents,
				execution: piExecution({ stream: scripted(script) }),
			});
			await quietNow(session, clock);
			const [, second] = questions;
			if (second === undefined) throw new Error('cast');
			const his = await session.visit(sam);
			await his.send({ text: second.text, key: second.key });
			await quietNow(session, clock);
			const before = await storedOf(journals, name);
			// The stopped process continues where it stood. Its stale room writes
			// are refused, and the durable journal remains readable.
			paused.continue();
			await Promise.race([paused.exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
			paused.kill();
			const after = await storedOf(childJournals('sqlite', dir), name);
			expect(after).toEqual(before);
			expect(after).toContainEqual(
				expect.objectContaining({ kind: 'message', key: `delivery:${second.key}` }),
			);
			await session.stop();
		} finally {
			paused.kill();
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	}, 60_000);
});
