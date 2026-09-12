/**
 * The split the design forbids, as a history: two live hosts over one
 * journal. The first host is paused, in this process by holding its writes
 * and in a process of its own with SIGSTOP, a second host resumes the
 * name, and the first comes back and keeps writing. In memory, the fence
 * holds: the first host's write past the fence is void, it acknowledges
 * that one write and no other, and it is superseded at its next write.
 * On JSONL, Pi refuses to load the file afterwards, so no run can open
 * the name again: the fence needs a storage whose reads see another
 * run's writes, and Pi's JSONL storage reads its own memory.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Seq } from '../src/index.ts';
import {
	createRuntime,
	inProcessTransport,
	resumeSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
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
import { collect, roomName, storedOf } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { gatedOpener, jsonlSessions, memory, sqlite } from './support/storage.ts';
import { serializing } from './support/transport.ts';

const RETRY = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

/** What the storage holds beside a body: the journal's own three. */
type Stored = Record<string, unknown> & { seq: Seq; key?: string };

/**
 * The stored entries as the fold reads them: the ones that stand past every
 * fence. The storage holds the journal's own three beside the body, so this
 * splits them off the way the journal does. A body handed over whole folds
 * with no place at all, and every check over the fold goes quiet.
 */
function entriesOf(stored: { type: string; data: unknown }[]): Entry[] {
	return standing(stored).flatMap((entry) => {
		const kind = entry.type.slice('ambion/'.length);
		if (kind !== 'message' && kind !== 'lease' && kind !== 'close' && kind !== 'composition') {
			return [];
		}
		const { seq, key, run: _run, ...body } = entry.data as Stored;
		return [{ kind, body, seq, ...(key === undefined ? {} : { key }) } as Entry];
	});
}

// A storage that refuses an append the record moved under loses nothing:
// the write the paused host held is refused before it is acknowledged.
describe.each([memory, sqlite])('a split on $name: two live hosts over one journal', (storage) => {
	const refuses = storage.name === 'sqlite';
	it('a paused host that comes back is fenced out, and loses only what the storage lets it', async () => {
		const opened = await storage.open();
		const clock = fakeClock();
		const history = new History(clock);
		// the first host's writes are held while it is paused; the second host's are not
		let gate: Promise<void> | undefined;
		let release = () => {};
		const first = createRuntime({
			sessions: gatedOpener(opened.sessions, () => gate),
			clock,
			agents,
			transport: serializing(inProcessTransport()),
		});
		const second = createRuntime({
			sessions: opened.sessions,
			clock,
			agents,
			transport: serializing(inProcessTransport()),
		});
		const name = roomName('split-pause');
		const room = startSession({
			name,
			runtime: first,
			assistant,
			agents: [product, colleague],
			streamFn: scripted(script),
		});
		const events = collect(room);
		const hers = await visitSession(room, priya);
		await history.run('priya', 'deliver', 'q1', () => hers.deliver({ text: 'First?', key: 'q1' }));
		await room.quiet();
		// paused: a delivery on the first host is in flight and held
		gate = new Promise((resolve) => {
			release = resolve;
		});
		const held = history.run('priya', 'deliver', 'q2', () =>
			hers.deliver({ text: 'Second?', key: 'q2' }),
		);
		// the second host takes the name and serves a question
		const taken = await resumeSession(name, { runtime: second, streamFn: scripted(script) });
		const his = await visitSession(taken, sam);
		await history.run('sam', 'deliver', 'q3', () => his.deliver({ text: 'Third?', key: 'q3' }));
		await taken.quiet();
		// the first host comes back: its held write lands past the fence, void, and it
		// acknowledges it; its next write finds the fence and it is superseded
		release();
		await held;
		await history.run('priya', 'deliver', 'q4', () => hers.deliver({ text: 'Fourth?', key: 'q4' }));
		await room.quiet();
		await history.run(
			'sam',
			'read',
			undefined,
			() => taken.messages(),
			(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
		);
		try {
			const stored = await storedOf(opened.sessions, name);
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
			// On a storage that takes any append, the fence allows one loss: the write
			// the first host acknowledged past the fence is off the record, and off
			// every read after it. On one that refuses an append the record moved
			// under, the write is refused before it is acknowledged, and nothing is lost.
			expect(found).toEqual(
				refuses
					? []
					: [
							'delivery q2 acknowledged, on the record 0 times',
							'read #9 by sam lacks delivery q2, acknowledged before it was asked',
						],
			);
			expect(history.entries.find((e) => e.key === 'q2' && e.phase !== 'invoke')).toMatchObject({
				phase: refuses ? 'fail' : 'ok',
			});
			expect(events.some((e) => e.type === 'superseded')).toBe(true);
			expect(history.entries.find((e) => e.key === 'q4' && e.phase !== 'invoke')).toMatchObject({
				phase: 'fail',
				error: expect.stringMatching(/superseded/),
			});
			expect(first.running.has(name)).toBe(false);
		} finally {
			await stopSession(taken);
			await opened.dispose();
		}
	});
});

describe('a split: two live hosts over one JSONL file', () => {
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
		const args = ['--experimental-transform-types', '--no-warnings', child, dir, name, '40'];
		const process_ = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
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

	async function quietNow(session: Session, clock: FakeClock): Promise<void> {
		for (let round = 0; round < 12; round += 1) {
			const settled = await Promise.race([
				session.quiet().then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
			]);
			if (settled && idle(session)) return;
			await clock.advance(2_000);
		}
		throw new Error('the room never went quiet');
	}

	it('a process stopped mid-activation and continued after a takeover leaves a file no run can open', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'ambion-split-'));
		const name = 'split';
		const paused = stopAt(dir, name, 6);
		try {
			await paused.stopped;
			const sessions = jsonlSessions(dir);
			const clock = fakeClock(Date.now());
			const runtime = createRuntime({ sessions, agents, clock, ...TIMING });
			const session = await resumeSession(name, { runtime, streamFn: scripted(script) });
			await quietNow(session, clock);
			const [, second] = questions;
			if (second === undefined) throw new Error('cast');
			const his = await visitSession(session, sam);
			await his.deliver({ text: second.text, key: second.key });
			await quietNow(session, clock);
			// the stopped process continues where it stood, and its writes land beside the
			// second host's: Pi's JSONL storage refuses the file from then on, so no run can
			// ever open the name again
			paused.continue();
			await Promise.race([paused.exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
			paused.kill();
			await expect(storedOf(jsonlSessions(dir), name)).rejects.toThrow(/non-consecutive seq/);
			await stopSession(session);
		} finally {
			paused.kill();
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	}, 60_000);
});
