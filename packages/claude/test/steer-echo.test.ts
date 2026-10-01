/**
 * Freshness rests on the echo. The SDK sends each user message back, and
 * `readThrough` advances on that echo and on nothing earlier. A line whose
 * echo arrives before the gap before it closes counts once the gap closes.
 * An abort ends the pass in flight at once.
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

it('holds a steered line whose echo arrives before the gap before it closes, and counts it once the gap closes', async () => {
	const run = open({ turns: [[{ awaitUser: 3 }, { say: 'Saturday.' }]] });
	const pass = run.session.pass({ kind: 'view', view: viewOf(1) });
	await until(() => run.session.readThrough === 1, 'the echo of the view');
	// The line at 4 lands first: the model has not read 2 and 3 yet.
	run.session.steer?.(3, 4, '[4] priya: And the permit.');
	await until(
		() => run.steps.some((step) => step.type === 'steer' && step.seq === 4),
		'the echo of the line at 4',
	);
	expect(run.session.readThrough).toBe(1);
	// The line through 3 closes the gap, and the line at 4 joins it.
	run.session.steer?.(1, 3, '[2] priya: Also bring the forms.\n[3] priya: Two copies.');
	expect(await pass).toEqual({ failed: false });
	expect(run.steps).toContainEqual({ type: 'steer', seq: 3, consumed: true });
	expect(run.commits[0]?.readThrough).toBe(4);
	run.session.close?.();
});

it('sends a steer that arrives before the first pass with the view', async () => {
	const run = open({ turns: [[{ awaitUser: 2 }, { say: 'Saturday.' }]] });
	run.session.steer?.(1, 2, '[2] priya: Also bring the forms.');
	await run.session.pass({ kind: 'view', view: viewOf(1) });
	expect(run.steps).toContainEqual({ type: 'steer', seq: 2, consumed: true });
	expect(run.commits[0]?.readThrough).toBe(2);
	run.session.close?.();
});

it('sends a line that lands while a later pass renders its record, and counts it on its echo', async () => {
	const run = open({
		turns: [[{ text: 'First.' }], [{ awaitUser: 3 }, { text: 'Second.' }]],
	});
	await run.session.pass({ kind: 'view', view: viewOf(1) });
	const first = viewOf(1);
	const view = {
		...first,
		through: 2,
		context: {
			...first.context,
			messages: [
				...first.context.messages,
				{
					kind: 'said' as const,
					seq: 2,
					at: new Date(0).toISOString(),
					from: 'priya',
					text: 'And the permit?',
				},
			],
		},
	};
	const second = run.session.pass({ kind: 'delta', since: 1, view });
	// The pass has not sent its prompt yet: the executor holds the line, and sends it after the prompt.
	run.session.steer(2, 3, '[3] priya: One more thing.');
	expect(await second).toEqual({ failed: false });
	expect(run.steps).toContainEqual({ type: 'steer', seq: 3, consumed: true });
	expect(run.session.readThrough).toBe(3);
	// The first view, the delta, and the steer reach the executable as written: no file mention, no slash command.
	const users = run.log().filter((line) => 'user' in line);
	expect(users).toHaveLength(3);
	expect(users.every((line) => line.composed === true)).toBe(true);
	run.session.close?.();
});

it('takes no line that lands outside a pass', async () => {
	const run = open({ turns: [[{ say: 'Saturday.' }]] });
	await run.session.pass({ kind: 'view', view: viewOf(1) });
	// The core never steers outside a pass. The executor still sends nothing then.
	run.sessions[0]?.steer?.(1, 2, '[2] priya: Late.');
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(run.log().filter((line) => 'user' in line)).toHaveLength(1);
	run.session.close?.();
});

it('ends the pass in flight on abort, commits nothing, and still counts the usage of the interrupted turn', async () => {
	const run = open({
		turns: [[{ usage: { input: 5, output: 1 } }, { awaitUser: 2 }, { say: 'Saturday.' }]],
	});
	const pass = run.session.pass({ kind: 'view', view: viewOf(1) });
	await until(() => run.session.readThrough === 1, 'the echo of the view');
	run.session.cancel();
	expect(await pass).toEqual({ failed: false });
	// The fake ends the interrupted turn with a result, and the stopped session only traces it.
	await until(() => run.steps.some((step) => step.type === 'usage'), 'the interrupted result');
	expect(run.steps).toContainEqual(expect.objectContaining({ type: 'usage', input: 5, output: 1 }));
	expect(run.commits).toEqual([]);
	run.session.close?.();
});
