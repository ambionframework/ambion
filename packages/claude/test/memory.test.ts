/**
 * Memory modes. `activation` opens a session per activation. `seat` persists
 * one session, records its id on the release, and resumes it. The fake
 * executable reports a `session` and honors or refuses a `--resume`.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	ActivationView,
	AgentDefinition,
	CommitRequest,
	ExecutorSession,
	HarnessSession,
	RoomProtocol,
	TraceSink,
} from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import { claude, createClaudeExecutor } from '../src/index.ts';
import type { FakeScenario } from '../src/testing.ts';
import { executable, seat, viewOf } from './support.ts';

const SAY = { turns: [[{ say: 'Saturday.' }]] } satisfies FakeScenario;

/** One executor for the seat, and a room that refuses a say against a record that moved. */
function seatRoom(
	definition: AgentDefinition,
	scenario: FakeScenario & { [key: string]: unknown },
) {
	const file = join(mkdtempSync(join(tmpdir(), 'ambion-claude-mem-')), 'fake.log');
	const commits: CommitRequest[] = [];
	const answers: string[] = [];
	let lastSeq = 1;
	const room: RoomProtocol = {
		view: async () => ({ stale: 'unused' }),
		lease: async () => ({ stale: 'unused' }),
		commit: async (request) => {
			commits.push(request);
			if ((request.readThrough ?? 0) < lastSeq) {
				answers.push('missed');
				return { missed: [] };
			}
			answers.push('committed');
			lastSeq += 1;
			return {
				committed: {
					kind: 'said',
					seq: lastSeq,
					at: new Date(0).toISOString(),
					from: 'sonnet',
					text: request.intent.kind === 'said' ? request.intent.text : '',
				},
			};
		},
	};
	const trace: TraceSink = {
		startPass: () => {},
		record: () => {},
		usage: () => undefined,
		close: async () => {},
	};
	const executor = createClaudeExecutor({
		definition,
		pathToClaudeCodeExecutable: executable,
		env: { ...process.env, AMBION_FAKE: JSON.stringify({ ...scenario, log: file }) },
	});
	return {
		commits,
		answers,
		moveRecordTo: (seq: number) => {
			lastSeq = seq;
		},
		activate: (id: string) => executor.open({ id, room, emit: () => {}, trace }) as ExecutorSession,
		argvs: () =>
			readFileSync(file, 'utf8')
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.flatMap((line) => ('argv' in line ? [line.argv as string[]] : [])),
	};
}

const resumeOf = (argv: string[] = []) =>
	argv.find((arg) => arg.startsWith('--resume='))?.slice('--resume='.length);

async function run(
	session: ExecutorSession,
	view: ActivationView,
): Promise<HarnessSession | undefined> {
	const result = await session.pass({ kind: 'view', view });
	expect(result).toMatchObject({ failed: false });
	const recorded = session.session;
	session.close?.();
	return recorded;
}

const viewWith = (through: number, resume?: HarnessSession): ActivationView => {
	const view = viewOf(through);
	return resume === undefined ? view : { ...view, spec: { ...view.spec, resume } };
};

describe('seat memory', () => {
	it('persists the session, records its id, and resumes it in the next activation', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), { ...SAY, session: 'sess-1' });
		const first = await run(room.activate('message:1:sonnet:1'), viewWith(1));
		expect(first).toEqual({ harness: 'claude', id: 'sess-1' });
		const second = await run(room.activate('message:2:sonnet:1'), viewWith(1));
		expect(second).toEqual(first);
		const [one, two] = room.argvs();
		expect(one).not.toContain('--no-session-persistence');
		expect(resumeOf(one)).toBeUndefined();
		expect(two).not.toContain('--no-session-persistence');
		expect(resumeOf(two)).toBe('sess-1');
	});

	it('resumes the session the room recorded when the executor is fresh', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), SAY);
		const recorded = await run(
			room.activate('message:3:sonnet:1'),
			viewWith(1, { harness: 'claude', id: 'from-journal' }),
		);
		expect(recorded).toEqual({ harness: 'claude', id: 'from-journal' });
		expect(resumeOf(room.argvs()[0])).toBe('from-journal');
	});

	it('ignores a recorded session of another harness', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), SAY);
		await run(room.activate('message:3:sonnet:1'), viewWith(1, { harness: 'pi', id: 'other' }));
		expect(resumeOf(room.argvs()[0])).toBeUndefined();
	});

	it('starts a fresh session when the SDK cannot resume, and records the new id', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), {
			...SAY,
			rejectResume: true,
			session: 'fresh',
		});
		const recorded = await run(
			room.activate('message:3:sonnet:1'),
			viewWith(1, { harness: 'claude', id: 'lost' }),
		);
		expect(recorded).toEqual({ harness: 'claude', id: 'fresh' });
		expect(room.commits).toHaveLength(1);
		const [first, second] = room.argvs();
		expect(resumeOf(first)).toBe('lost');
		expect(resumeOf(second)).toBeUndefined();
	});

	it('starts a fresh session when the SDK answers a resume with an error result', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), {
			...SAY,
			rejectResumeResult: true,
			session: 'fresh',
		});
		const recorded = await run(
			room.activate('message:3:sonnet:1'),
			viewWith(1, { harness: 'claude', id: 'lost' }),
		);
		expect(recorded).toEqual({ harness: 'claude', id: 'fresh' });
		expect(room.commits).toHaveLength(1);
		const [first, second] = room.argvs();
		expect(resumeOf(first)).toBe('lost');
		expect(resumeOf(second)).toBeUndefined();
	});

	it('reports a second failure after the restart and does not loop', async () => {
		const failure = 'No conversation found with session ID: again';
		const room = seatRoom(seat({ memory: 'seat' }), {
			turns: [[{ fail: { status: 500, text: failure } }]],
			rejectResumeResult: true,
		});
		const activation = room.activate('message:3:sonnet:1');
		const result = await activation.pass({
			kind: 'view',
			view: viewWith(1, { harness: 'claude', id: 'lost' }),
		});
		activation.close?.();
		expect(result).toMatchObject({ failed: true, message: failure });
		expect(room.argvs()).toHaveLength(2);
	});

	it('does not restart a real failure of a resumed session', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), {
			turns: [[{ fail: { status: 529, text: 'API Error: 529 overloaded_error' } }]],
		});
		const activation = room.activate('message:3:sonnet:1');
		const result = await activation.pass({
			kind: 'view',
			view: viewWith(1, { harness: 'claude', id: 'held' }),
		});
		activation.close?.();
		expect(result).toMatchObject({ failed: true, cause: 'transient' });
		expect(room.argvs()).toHaveLength(1);
	});

	it('refuses a say against a record that moved, as activation memory does', async () => {
		const room = seatRoom(seat({ memory: 'seat' }), { ...SAY, session: 'sess-1' });
		await run(room.activate('message:1:sonnet:1'), viewWith(1));
		room.moveRecordTo(3);
		await run(
			room.activate('message:2:sonnet:1'),
			viewWith(2, { harness: 'claude', id: 'sess-1' }),
		);
		expect(room.commits.at(-1)?.readThrough).toBe(2);
		expect(room.answers.at(-1)).toBe('missed');
	});
});

describe('activation memory', () => {
	it('persists nothing, resumes nothing, and records no session', async () => {
		const room = seatRoom(seat(), { ...SAY, session: 'sess-1' });
		expect(await run(room.activate('message:1:sonnet:1'), viewWith(1))).toBeUndefined();
		expect(
			await run(room.activate('message:2:sonnet:1'), viewWith(1, { harness: 'claude', id: 'x' })),
		).toBeUndefined();
		for (const argv of room.argvs()) {
			expect(argv).toContain('--no-session-persistence');
			expect(resumeOf(argv)).toBeUndefined();
		}
	});

	it('mirrors the option onto the executor', () => {
		expect(claude({ instructions: '', model: 'm' }).memory).toBeUndefined();
		expect(claude({ instructions: '', model: 'm', memory: 'seat' }).memory).toBe('seat');
	});
});
