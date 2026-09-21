/** The memory modes: a seat that resumes its thread, and a resume that falls back. */
import type { ExecutorSession, PassInput } from '@ambionframework/ambion/hosting';
import { describe, expect, it } from 'vitest';
import { recorded } from './fixtures.ts';
import { open, seat, viewOf } from './support.ts';

const input = (): PassInput => ({ kind: 'view', view: viewOf() }) as PassInput;
const ID = '01a0c21c-ffca-7082-9772-3bac91d64bc7';

/** Run one pass of a session and read the session it reports. */
async function run(session: ExecutorSession) {
	const result = await session.pass(input());
	session.close?.();
	return { result, session: session.session };
}

describe('memory activation', () => {
	it('opens a fresh thread for each activation and records no session', async () => {
		const room = open([recorded('plain-answer'), recorded('plain-answer')]);
		const first = await run(room.activate('a1'));
		const second = await run(room.activate('a2'));
		expect(first.result).toEqual({ failed: false });
		expect(first.session).toBeUndefined();
		expect(second.session).toBeUndefined();
		expect(room.seen.opened).toEqual([{ resume: undefined }, { resume: undefined }]);
	});
});

describe('memory seat', () => {
	const definition = seat({ memory: 'seat' });

	it('records the thread id of the first activation', async () => {
		const room = open([recorded('plain-answer')], definition);
		const { session } = await run(room.activate());
		expect(session).toEqual({ harness: 'codex', id: ID });
	});

	it('resumes that thread in the next activation', async () => {
		const room = open([recorded('plain-answer'), recorded('plain-answer')], definition);
		await run(room.activate('a1'));
		await run(room.activate('a2'));
		expect(room.seen.opened).toEqual([{ resume: undefined }, { resume: ID }]);
	});

	it('resumes the thread the room recorded, after a restart', async () => {
		const room = open([recorded('plain-answer')], definition);
		const view = viewOf();
		const resumed = { ...view, spec: { ...view.spec, resume: { harness: 'codex', id: 'saved' } } };
		const session = room.activate();
		await session.pass({ kind: 'view', view: resumed } as PassInput);
		session.close?.();
		expect(room.seen.opened).toEqual([{ resume: 'saved' }]);
	});

	it('ignores a session that another harness recorded', async () => {
		const room = open([recorded('plain-answer')], definition);
		const view = viewOf();
		const foreign = { ...view, spec: { ...view.spec, resume: { harness: 'claude', id: 'x' } } };
		const session = room.activate();
		await session.pass({ kind: 'view', view: foreign } as PassInput);
		session.close?.();
		expect(room.seen.opened).toEqual([{ resume: undefined }]);
	});

	it('starts a fresh thread when the resume fails before the thread starts', async () => {
		const room = open(
			[new Error('Codex Exec exited with code 1: no session'), recorded('plain-answer')],
			definition,
		);
		const view = viewOf();
		const bogus = { ...view, spec: { ...view.spec, resume: { harness: 'codex', id: 'bogus' } } };
		const session = room.activate();
		const result = await session.pass({ kind: 'view', view: bogus } as PassInput);
		session.close?.();
		expect(result).toEqual({ failed: false });
		expect(room.seen.opened).toEqual([{ resume: 'bogus' }, { resume: undefined }]);
		expect(room.seen.prompts).toHaveLength(2);
		expect(room.seen.prompts[1]).toBe(room.seen.prompts[0]);
		expect(session.session).toEqual({ harness: 'codex', id: ID });
		expect(room.events.filter((event) => event.type === 'error')).toEqual([]);
	});

	it('reports a failure of a fresh thread and does not try again', async () => {
		const room = open([new Error('connection reset')], definition);
		const session = room.activate();
		const result = await session.pass(input());
		session.close?.();
		expect(result).toMatchObject({ failed: true, cause: 'transient', message: 'connection reset' });
		expect(room.seen.opened).toEqual([{ resume: undefined }]);
	});
});
