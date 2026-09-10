/**
 * The room crashes at every write, and is killed from outside; every time,
 * a host resumes it and the scenario comes to the same record.
 *
 * The sweep runs one scenario once to count the appends its log takes, then
 * runs it once per append, crashing the room at that append: before the
 * entry lands, and again after it landed and before the room heard. The
 * world resumes the name in a fresh runtime and retries the host action
 * that failed under the same key, the way a host does after a process
 * dies. The kill runs the same scenario in a child process on a JSONL
 * storage, sends SIGKILL at a write, and resumes over the directory.
 *
 * `AMBION_CHAOS=all` widens both: the sweep runs on JSONL too, and the
 * kill lands on every third write.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	createRuntime,
	isPresence,
	resumeSession,
	type Session,
	stopSession,
	visitSession,
} from '../src/index.ts';
import { agents, priya, type Question, questions, sam, script, TIMING } from './support/cast.ts';
import { idle, liveLeases, outcome, World, within } from './support/chaos.ts';
import { type FakeClock, fakeClock } from './support/clock.ts';
import { invariants } from './support/invariants.ts';
import { collect, roomName } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { jsonl, jsonlSessions, memory, type Storage } from './support/storage.ts';

const full = process.env.AMBION_CHAOS === 'all';

/** The appends an untroubled run takes: the crash points the sweep visits. */
async function countWrites(storage: Storage): Promise<number> {
	const opened = await storage.open();
	const world = new World(roomName('chaos-count'), opened);
	try {
		await world.run();
		await world.check();
		// the stop writes too, and no sweep run gets that far before its check
		const writes = world.writes;
		await stopSession(world.room);
		return writes;
	} finally {
		await opened.dispose();
	}
}

const writes = await countWrites(memory);
const points = Array.from({ length: writes }, (_, i) => i + 1);

describe.each(full ? [memory, jsonl] : [memory])('a crash at every write on $name', (storage) => {
	describe.each(['before', 'after'] as const)('%s the entry lands', (mode) => {
		it.each(points)(
			`at write %i of ${writes}, the room resumes and the scenario ends whole`,
			async (at) => {
				const opened = await storage.open();
				const world = new World(roomName(`chaos-${storage.name}-${mode}`), opened, { at, mode });
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

// -- a kill from outside --------------------------------------------------------

const child = fileURLToPath(new URL('./support/child.ts', import.meta.url));

/**
 * Run the child until its log takes `at` appends, then kill it without
 * warning. Returns the last append it reported, which may be past `at`.
 */
function killAt(dir: string, name: string, at: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const args = ['--experimental-transform-types', '--no-warnings', child, dir, name, '40'];
		const process_ = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		let last = 0;
		let buffer = '';
		process_.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const reported = /^write (\d+)$/.exec(line);
				if (reported) last = Number(reported[1]);
				if (last >= at || line === 'done') process_.kill('SIGKILL');
			}
		});
		process_.on('exit', () => resolve(last));
		process_.on('error', reject);
	});
}

/**
 * Time moves until the room is quiet with nothing owed: the lease the
 * killed process held expires, and every retry's backoff passes. The
 * clock is the room's own, so the wait is the test's to move.
 */
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

/** The scenario from wherever the child got to, each step a no-op where the log holds it already. */
async function finish(session: Session, clock: FakeClock): Promise<void> {
	const [first, second, third] = questions as [Question, Question, Question];
	const deliver = async (question: Question) => {
		const visit = await visitSession(session, question.person);
		await visit.deliver({
			text: question.text,
			key: question.key,
			...(question.to === undefined ? {} : { to: question.to }),
		});
	};
	await deliver(first);
	await quietNow(session, clock);
	const record = await session.messages();
	const hers = record
		.filter(isPresence)
		.filter((m) => m.from === priya.name)
		.at(-1);
	if (hers?.kind !== 'left') await (await visitSession(session, priya)).leave();
	await deliver(second);
	await quietNow(session, clock);
	await deliver(third);
	await quietNow(session, clock);
	expect(session.seats().find((s) => s.name === sam.name)).toMatchObject({ presence: 'present' });
}

describe('a room killed from outside', () => {
	const kills = full ? Array.from({ length: 14 }, (_, i) => 2 + i * 3) : [3, 12];
	it.each(kills)(
		'killed at write %i, resumed over its directory, and the scenario ends whole',
		async (at) => {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-kill-'));
			const name = 'killed';
			try {
				const reached = await killAt(dir, name, at);
				// the child died at the kill, and not on its own before it
				expect(reached).toBeGreaterThanOrEqual(at);
				const sessions = jsonlSessions(dir);
				// The room resumes on a clock that stands where the child's ran, and the test moves it:
				// a lease the child held is live at the resume and expires when the test says so.
				const clock = fakeClock(Date.now());
				const runtime = createRuntime({ sessions, agents, clock, ...TIMING });
				const inherited = await liveLeases(sessions, name, clock.now());
				const session = await resumeSession(name, { runtime, streamFn: scripted(script) });
				const events = collect(session);
				const inheritedExchange = session.exchange() !== undefined;
				await finish(session, clock);
				const errors = events.flatMap((e) => (e.type === 'error' ? [e.error.message] : []));
				expect(errors.filter((m) => !/past its lease/.test(m))).toEqual([]);
				await invariants(session, events, {
					sessions,
					allowErrors: inherited,
					inherited,
					inheritedExchange,
				});
				await outcome(session, sessions);
				await stopSession(session);
			} finally {
				await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			}
		},
		60_000,
	);
});
