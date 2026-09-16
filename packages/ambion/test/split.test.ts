/**
 * The split the design forbids, as a history: two live hosts over one
 * journal. The first host is paused, in this process by holding its writes
 * and in a process of its own with SIGSTOP, a second host resumes the
 * name, and the first comes back and keeps writing. Conditional appends
 * refuse the first host's held write when the second host takes the name.
 * A child that uses JSONL for its transcripts keeps the record in the
 * durable journal. A second host can resume the name while the child is
 * stopped, and the child cannot corrupt the record when it continues.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JournalEntry } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { runningRoom } from '../src/host/runtime.ts';
import { createRuntime, type Room, resumeRoom, startRoom } from '../src/index.ts';
import type { Entry as RoomEntry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { inProcessTransport } from '../src/transport.ts';
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
import { idle } from './support/chaos.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { History, standing, violations } from './support/history.ts';
import { collect, roomName, storedOf, waitForRoom } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { childJournals, childStorage, gatedJournals, memory, sqlite } from './support/storage.ts';
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

describe.each([memory, sqlite])('a split on $name: two live hosts over one journal', (storage) => {
	it('a paused host that comes back is fenced out before its held write lands', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const history = new History(clock);
		// the first host's writes are held while it is paused; the second host's are not
		let gate: Promise<void> | undefined;
		let release = () => {};
		const first = createRuntime({
			storage: gatedJournals(opened.storage, () => gate),
			clock,
			transport: serializing(inProcessTransport()),
		});
		const second = createRuntime({
			storage: opened.storage,
			clock,
			transport: serializing(inProcessTransport()),
		});
		const name = roomName('split-pause');
		const room = await startRoom({
			name,
			runtime: first,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(script),
		});
		const events = collect(room);
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
		const taken = await resumeRoom(name, {
			runtime: second,
			agents,
			streamFn: scripted(script),
		});
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
			() => taken.messages(),
			(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
		);
		try {
			const stored = await storedOf(opened.journals, name);
			const folded = foldRoom(entriesOf(stored), RETRY);
			// The fold read the record. A fold that reads no place answers every
			// check below with nothing, and the checks say the room is whole.
			expect(folded.lastSeq).toBeGreaterThan(0);
			expect(folded.messages.every((message) => message.seq > 0)).toBe(true);
			const found = violations(history, {
				record: await taken.messages(),
				stored,
				state: folded,
			});
			expect(found).toEqual([]);
			expect(history.entries.find((e) => e.key === 'q2' && e.phase !== 'invoke')).toMatchObject({
				phase: 'fail',
			});
			expect(events.some((e) => e.type === 'superseded')).toBe(true);
			expect(history.entries.find((e) => e.key === 'q4' && e.phase !== 'invoke')).toMatchObject({
				phase: 'fail',
			});
			expect(runningRoom(first, name)).toBeUndefined();
		} finally {
			await taken.stop();
			await opened.dispose();
		}
	});
});

describe('a split: two live hosts over one SQLite database', () => {
	const child = fileURLToPath(new URL('./support/child.ts', import.meta.url));

	/** Every `write N` line the child prints, as it prints it. */
	function writes(stdout: NodeJS.ReadableStream, report: (last: number) => void): void {
		let buffer = '';
		stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const reported = /^write (\d+)$/.exec(line);
				if (reported) report(Number(reported[1]));
			}
		});
	}

	/** Run the child until its journal takes `at` appends, then stop it where it stands. */
	function stopAt(dir: string, name: string, at: number) {
		const args = ['--no-warnings', child, dir, name, '40'];
		const process_ = spawn(node, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		const exited = new Promise<void>((resolve) => process_.on('exit', () => resolve()));
		const stopped = new Promise<number>((resolve, reject) => {
			let sent = false;
			// stopped once, where it stands; what it writes after the continue is its own
			writes(process_.stdout, (last) => {
				if (last < at || sent) return;
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

	async function quietNow(session: Room, clock: FakeClock): Promise<void> {
		for (let round = 0; round < 12; round += 1) {
			const settled = await Promise.race([
				session.messages().then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
			]);
			if (settled && idle(session)) return;
			await clock.advance(2_000);
		}
		throw new Error('the room never went quiet');
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
			const session = await resumeRoom(name, { runtime, agents, streamFn: scripted(script) });
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
			expect(after).toContainEqual(expect.objectContaining({ kind: 'message', key: second.key }));
			await session.stop();
		} finally {
			paused.kill();
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	}, 60_000);
});
