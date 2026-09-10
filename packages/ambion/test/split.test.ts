/**
 * The split the design forbids, as a history: two live hosts over one
 * log. The first host is paused, in this process by holding its writes
 * and in a process of its own with SIGSTOP, a second host resumes the
 * name, and the first comes back and keeps writing. Nothing fences the
 * first host out yet, and these tests pin what the storage ends up with:
 * in memory, a seq on the storage twice and a delivery the first host
 * acknowledged that the record lacks; on JSONL, a file Pi refuses to
 * load, so no run can open the name again. They turn when a fence lands.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	inProcessTransport,
	resumeSession,
	type Session,
	startSession,
	stopSession,
	visitSession,
} from '../src/index.ts';
import type { LogEntry } from '../src/log/log.ts';
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
import { History, violations } from './support/history.ts';
import { roomName, rowsOf } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { gatedOpener, jsonlSessions, memory } from './support/storage.ts';
import { serializing } from './support/transport.ts';

const RETRY = { attempts: 3, backoff: (attempt: number) => attempt * 30_000 };

/** The rows as the fold reads them. */
function entriesOf(rows: { type: string; data: unknown }[]): LogEntry[] {
	return rows.flatMap((row) => {
		const type = row.type.slice('ambion/'.length);
		if (type === 'message') return [{ type, message: row.data } as LogEntry];
		if (type === 'lease') return [{ type, lease: row.data } as LogEntry];
		if (type === 'close') return [{ type, close: row.data } as LogEntry];
		if (type === 'composition') return [{ type, composition: row.data } as LogEntry];
		return [];
	});
}

describe('a split: two live hosts over one log', () => {
	it('a paused host that comes back writes a seq twice, and its delivery is off the record', async () => {
		const opened = await memory.open();
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
		// the first host comes back: its held write lands
		release();
		await held;
		await room.quiet();
		await history.run(
			'sam',
			'read',
			undefined,
			() => taken.messages(),
			(record) => record.map((m) => ({ seq: m.seq, key: m.key })),
		);
		try {
			const rows = await rowsOf(opened.sessions, name);
			const found = violations(history, {
				record: await taken.messages(),
				rows,
				state: foldRoom(entriesOf(rows), RETRY),
			});
			expect(found).toContainEqual(expect.stringMatching(/^seq \d+ is on the storage 2 times$/));
			expect(found).toContainEqual('delivery q2 acknowledged, on the record 0 times');
		} finally {
			await stopSession(room);
			await stopSession(taken);
			await opened.dispose();
		}
	});

	const child = fileURLToPath(new URL('./support/child.ts', import.meta.url));

	/** Run the child until its log takes `at` appends, then stop it where it stands. */
	function stopAt(dir: string, name: string, at: number) {
		const args = ['--experimental-transform-types', '--no-warnings', child, dir, name, '40'];
		const process_ = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		const exited = new Promise<void>((resolve) => process_.on('exit', () => resolve()));
		const stopped = new Promise<number>((resolve, reject) => {
			let last = 0;
			let buffer = '';
			process_.stdout.on('data', (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';
				for (const line of lines) {
					const reported = /^write (\d+)$/.exec(line);
					if (reported) last = Number(reported[1]);
					if (last >= at) {
						process_.kill('SIGSTOP');
						resolve(last);
					}
				}
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
			await expect(rowsOf(jsonlSessions(dir), name)).rejects.toThrow(/non-consecutive seq/);
			await stopSession(session);
		} finally {
			paused.kill();
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
		}
	}, 60_000);
});
