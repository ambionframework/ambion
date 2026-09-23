/**
 * Freshness rests on the echo. The SDK sends each user message back, and
 * `readThrough` advances on that echo and on nothing earlier. An abort ends
 * the pass in flight at once.
 */
import { expect, it } from 'vitest';
import { open, until, viewOf } from './support.ts';

it('advances readThrough on the echo of a steered line, and a say after it commits fresh', async () => {
	const run = open({ turns: [[{ awaitUser: 2 }, { say: 'Saturday.' }]] });
	const pass = run.session.pass({ kind: 'view', view: viewOf(1) });
	// The model has read nothing until the SDK echoes the view.
	expect(run.session.readThrough).toBe(0);
	await until(() => run.session.readThrough === 1, 'the echo of the view');
	run.session.steer?.(1, 2, '[2] priya: Also bring the forms.');
	const result = await pass;
	expect(result).toEqual({ failed: false });
	expect(run.steps).toContainEqual({ type: 'steer', seq: 2, consumed: true });
	expect(run.commits).toHaveLength(1);
	expect(run.commits[0]?.readThrough).toBe(2);
	expect(run.session.readThrough).toBeGreaterThanOrEqual(2);
	run.session.close?.();
});

it.each([
	{
		what: 'sends a held steer with the view',
		turn: [{ awaitUser: 2 }, { say: 'Saturday.' }],
		through: 1,
	},
	{
		what: 'takes a held steer that the view already holds as read and sends nothing',
		turn: [{ say: 'Saturday.' }],
		through: 2,
	},
])('$what, when the steer arrives before the first pass', async ({ turn, through }) => {
	const run = open({ turns: [turn] });
	run.session.steer?.(1, 2, '[2] priya: Also bring the forms.');
	await run.session.pass({ kind: 'view', view: viewOf(through) });
	expect(run.steps).toContainEqual({ type: 'steer', seq: 2, consumed: true });
	expect(run.commits[0]?.readThrough).toBe(2);
	run.session.close?.();
});

it('does not advance readThrough before the echo of the first view, and records a steer that finds no pass in flight as not consumed', async () => {
	const run = open({ turns: [[{ say: 'Saturday.' }]] });
	expect(run.session.readThrough).toBe(0);
	await run.session.pass({ kind: 'view', view: viewOf(1) });
	expect(run.commits[0]?.readThrough).toBe(1);
	run.session.steer?.(1, 3, '[3] priya: One more thing.');
	expect(run.steps).toContainEqual({ type: 'steer', seq: 3, consumed: false });
	expect(run.session.shouldRefresh(3)).toBe(true);
	run.session.close?.();
});

it('ends the pass in flight on abort, commits nothing, and still counts the usage of the interrupted turn', async () => {
	const run = open({
		turns: [[{ usage: { input: 5, output: 1 } }, { awaitUser: 2 }, { say: 'Saturday.' }]],
	});
	const pass = run.session.pass({ kind: 'view', view: viewOf(1) });
	await until(() => run.session.readThrough === 1, 'the echo of the view');
	run.session.abort();
	expect(await pass).toEqual({ failed: false });
	// The fake ends the interrupted turn with a result, and the stopped session only traces it.
	await until(() => run.steps.some((step) => step.type === 'usage'), 'the interrupted result');
	expect(run.steps).toContainEqual(expect.objectContaining({ type: 'usage', input: 5, output: 1 }));
	expect(run.commits).toEqual([]);
	run.session.close?.();
});
