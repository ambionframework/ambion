/**
 * What the trace shows of a real activation: the reasoning of the model, the
 * session step, and the notice that names the Codex thread and its rollout
 * file.
 */
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { KEY_VAR, live, open, person, seat, untilQuiet } from './support.ts';

live('the trace of an activation', () => {
	it('holds the reasoning summary, the session step, and the thread with its rollout file', async () => {
		const {
			room,
			steps: stepsOf,
			events,
		} = await open('visibility', {
			agents: [
				seat('clerk', {
					instructions: 'Think it through, then answer through one say, in one sentence.',
					modelReasoningEffort: 'high',
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({
				text: 'A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. What does the ball cost?',
			});
			await untilQuiet(room);

			const ended = events.filter((event) => event.type === 'activation_end');
			const activation = ended.find((event) => event.seat === 'clerk')?.activation ?? '';
			const steps = stepsOf(activation);

			// The model asked for a summary of its reasoning, and the trace holds it.
			const thinking = steps.filter((step) => step.type === 'thinking');
			expect(thinking.some((step) => step.text.trim().length > 0)).toBe(true);

			// One notice names the thread, the home, and the rollout file that holds the thread.
			const notices = steps.flatMap((step) =>
				step.type === 'notice' && step.level === 'info' ? [step] : [],
			);
			expect(notices).toHaveLength(1);
			const data = notices[0]?.data as { thread?: string; rollout?: string } | undefined;
			expect(data?.thread).toEqual(expect.any(String));
			expect(data?.rollout).toEqual(expect.any(String));
			const rollout = data?.rollout ?? '';
			expect(existsSync(rollout)).toBe(true);
			expect(readFileSync(rollout, 'utf8')).toContain(data?.thread ?? '-');

			// The session step names what the thread started with, and holds no credential.
			const [session, ...more] = steps.filter((step) => step.type === 'session');
			expect(more).toEqual([]);
			expect(session).toMatchObject({
				name: 'codex',
				version: expect.stringMatching(/^\d+\.\d+\.\d+/),
				model: 'gpt-5.6-luna',
				session: data?.thread,
				permissionMode: 'never, readOnly',
			});
			// A seat on the ChatGPT login has no key to leak.
			const key = process.env[KEY_VAR];
			if (key) expect(JSON.stringify(session)).not.toContain(key);
		} finally {
			await room.stop();
		}
	});
});
