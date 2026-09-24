/**
 * The room crashes at every write, and is killed from outside; every time,
 * a host resumes it and the scenario comes to the same record.
 *
 * The sweep runs one scenario once to count the appends its journal takes, then
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
import { piExecution } from '../../pi/src/index.ts';
import { createRuntime, isPresence, type Room, resumeRoom } from '../src/index.ts';
import { type FakeClock, fakeClock } from '../src/testing.ts';
import { agents, priya, type Question, questions, sam, script, TIMING } from './support/cast.ts';
import { liveLeases, outcome } from './support/chaos.ts';
import { childWrites, countWrites, crashOnce, quietNow } from './support/core-failure.ts';
import { invariants } from './support/invariants.ts';
import { collect, currentExchange, messagesOf, participantsOf } from './support/room.ts';
import { scripted } from './support/scripted.ts';
import { childJournals, childStorage, memory, storages } from './support/storage.ts';

const full = process.env.AMBION_CHAOS === 'all';
const node = process.env.AMBION_NODE ?? process.execPath;

const writes = await countWrites(memory);
const points = Array.from({ length: writes }, (_, i) => i + 1);

describe.each(full ? storages : [memory])('a crash at every write on $name', (storage) => {
	describe.each(['before', 'after'] as const)('%s the entry lands', (mode) => {
		it.each(points)(
			`at write %i of ${writes}, the room resumes and the scenario ends whole`,
			(at) => crashOnce(storage, `chaos-${storage.name}`, { at, mode }),
			30_000,
		);
	});
});

// -- a kill from outside --------------------------------------------------------

const child = fileURLToPath(new URL('./support/child.ts', import.meta.url));

/**
 * Run the child until its journal takes `at` appends, then kill it without
 * warning. Returns the last append it reported, which may be past `at`.
 */
function killAt(dir: string, name: string, at: number, storage: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const args = ['--no-warnings', child, dir, name, '40', storage];
		const process_ = spawn(node, args, { stdio: ['ignore', 'pipe', 'inherit'] });
		let last = 0;
		childWrites(process_.stdout, (reported) => {
			if (reported !== 'done') last = reported;
			if (last >= at || reported === 'done') process_.kill('SIGKILL');
		});
		process_.on('exit', () => resolve(last));
		process_.on('error', reject);
	});
}

/** The scenario from wherever the child got to, each step a no-op where the journal holds it already. */
async function finish(session: Room, clock: FakeClock): Promise<void> {
	const [first, second, third] = questions as [Question, Question, Question];
	const deliver = async (question: Question) => {
		const visit = await session.visit(question.person);
		await visit.send({
			text: question.text,
			key: question.key,
			...(question.to === undefined ? {} : { to: question.to }),
		});
	};
	await deliver(first);
	await quietNow(session, clock);
	const record = await messagesOf(session);
	const hers = record
		.filter(isPresence)
		.filter((m) => m.from === priya.name)
		.at(-1);
	if (hers?.kind !== 'left') await (await session.visit(priya)).leave();
	await deliver(second);
	await quietNow(session, clock);
	await deliver(third);
	await quietNow(session, clock);
	expect((await participantsOf(session)).find((s) => s.name === sam.name)).toMatchObject({
		presence: 'present',
	});
}

// A kill lands between an entry and whatever the storage writes beside it,
// so each storage takes it: a room that resumes reads what the kill left.
describe.each(['sqlite'])('a room killed from outside on %s', (storage) => {
	const kills = full ? Array.from({ length: 14 }, (_, i) => 2 + i * 3) : [3, 12];
	it.each(kills)(
		'killed at write %i, resumed over its directory, and the scenario ends whole',
		async (at) => {
			const dir = await mkdtemp(join(tmpdir(), 'ambion-kill-'));
			const name = 'killed';
			try {
				const reached = await killAt(dir, name, at, storage);
				// the child died at the kill, and not on its own before it
				expect(reached).toBeGreaterThanOrEqual(at);
				const journals = childJournals(storage, dir);
				// The room resumes on a clock that stands where the child's ran, and the test moves it:
				// a lease the child held is live at the resume and expires when the test says so.
				const clock = fakeClock(Date.now());
				const runtime = createRuntime({
					storage: childStorage(storage, dir),
					clock,
					...TIMING,
				});
				const inherited = await liveLeases(journals, name, clock.now());
				const session = await resumeRoom(name, {
					runtime,
					agents,
					execution: piExecution({ sessions: 'memory', stream: scripted(script) }),
				});
				const events = collect(session);
				const inheritedExchange = (await currentExchange(session)) !== undefined;
				await finish(session, clock);
				const errors = events.flatMap((e) => (e.type === 'error' ? [e.error.message] : []));
				expect(errors.filter((m) => !/past its lease/.test(m))).toEqual([]);
				await invariants(session, events, {
					journals,
					allowErrors: inherited,
					inherited,
					inheritedExchange,
				});
				await outcome(session, journals);
				await session.stop();
			} finally {
				await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
			}
		},
		60_000,
	);
});
