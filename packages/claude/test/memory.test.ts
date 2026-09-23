/**
 * Memory modes. `activation` opens a session per activation. `seat` persists
 * one session, records its id on the release, and resumes it. The fake
 * executable reports a `session` and honors or refuses a `--resume`.
 */
import type {
	ActivationView,
	ExecutorSession,
	HarnessSession,
} from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import { claude } from '../src/index.ts';
import { fakeRoom, seat, viewOf } from './support.ts';

const SAY = { turns: [[{ say: 'Saturday.' }]] };
const seatMemory = seat({ memory: 'seat' });

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
		const room = fakeRoom({ ...SAY, session: 'sess-1' }, seatMemory);
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

	it('resumes the session the room recorded when the executor is fresh, and ignores one of another harness', async () => {
		const room = fakeRoom(SAY, seatMemory);
		const recorded = await run(
			room.activate('message:3:sonnet:1'),
			viewWith(1, { harness: 'claude', id: 'from-journal' }),
		);
		expect(recorded).toEqual({ harness: 'claude', id: 'from-journal' });
		const other = fakeRoom(SAY, seatMemory);
		await run(other.activate('message:3:sonnet:1'), viewWith(1, { harness: 'pi', id: 'other' }));
		expect(resumeOf(room.argvs()[0])).toBe('from-journal');
		expect(resumeOf(other.argvs()[0])).toBeUndefined();
	});

	it.each(['rejectResume', 'rejectResumeResult'] as const)(
		'starts a fresh session when the SDK cannot resume (%s), and records the new id',
		async (refusal) => {
			const room = fakeRoom({ ...SAY, [refusal]: true, session: 'fresh' }, seatMemory);
			const recorded = await run(
				room.activate('message:3:sonnet:1'),
				viewWith(1, { harness: 'claude', id: 'lost' }),
			);
			expect(recorded).toEqual({ harness: 'claude', id: 'fresh' });
			expect(room.commits).toHaveLength(1);
			const [first, second] = room.argvs();
			expect(resumeOf(first)).toBe('lost');
			expect(resumeOf(second)).toBeUndefined();
		},
	);

	it.each([
		{
			what: 'reports a second failure after the restart and does not loop',
			fail: { status: 500, text: 'No conversation found with session ID: again' },
			rejectResumeResult: true,
			result: { failed: true, message: 'No conversation found with session ID: again' },
			starts: 2,
		},
		{
			what: 'does not restart a real failure of a resumed session',
			fail: { status: 529, text: 'API Error: 529 overloaded_error' },
			rejectResumeResult: false,
			result: { failed: true, cause: 'transient' },
			starts: 1,
		},
	])('$what', async ({ fail, rejectResumeResult, result, starts }) => {
		const room = fakeRoom({ turns: [[{ fail }]], rejectResumeResult }, seatMemory);
		const activation = room.activate('message:3:sonnet:1');
		const answer = await activation.pass({
			kind: 'view',
			view: viewWith(1, { harness: 'claude', id: 'lost' }),
		});
		activation.close?.();
		expect(answer).toMatchObject(result);
		expect(room.argvs()).toHaveLength(starts);
	});

	it('refuses a say against a record that moved, as activation memory does', async () => {
		const room = fakeRoom({ ...SAY, session: 'sess-1' }, seatMemory);
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
		const room = fakeRoom({ ...SAY, session: 'sess-1' });
		expect(await run(room.activate('message:1:sonnet:1'), viewWith(1))).toBeUndefined();
		expect(
			await run(room.activate('message:2:sonnet:1'), viewWith(1, { harness: 'claude', id: 'x' })),
		).toBeUndefined();
		for (const argv of room.argvs()) {
			expect(argv).toContain('--no-session-persistence');
			expect(resumeOf(argv)).toBeUndefined();
		}
		expect(claude({ instructions: '', model: 'm' }).memory).toBeUndefined();
		expect(claude({ instructions: '', model: 'm', memory: 'seat' }).memory).toBe('seat');
	});
});
