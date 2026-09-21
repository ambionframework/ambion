/**
 * One real activation writes the steps every executor family shares, and
 * `readActivation` returns them with the usage the SDK reported.
 */
import { expect, it } from 'vitest';
import { readActivation, type TraceStep } from '../../../ambion/src/index.ts';
import { enter } from '../../../ambion/test/support/room.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

live('trace and usage', () => {
	it('an activation writes text, tool_call, room, usage and end steps with usage above zero', async () => {
		const clerk = seat('clerk', 'Site clerk. Answers scheduling questions.', {
			instructions: `
				Before you call any tool, write one plain sentence that says what you
				will do. Then answer the question with one say, in one sentence.
			`,
		});
		const { session, runtime, name, events } = await open('trace', [clerk]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start' && e.agent === 'clerk') resolve(e.activation);
				});
			});
			await visit.send({ text: 'Is Saturday a working day on site?' });
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);

			// The trace closes after the room reports quiet: read until the end step lands.
			let steps: TraceStep[] = [];
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const read = await readActivation(name, activation, { runtime });
				steps = (read?.passes ?? []).flatMap((pass) => [...pass.steps]);
				if (steps.some((step) => step.type === 'end')) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const types = new Set(steps.map((step) => step.type));
			for (const type of ['text', 'tool_call', 'room', 'usage', 'end'] as const) {
				expect(types, `a ${type} step`).toContain(type);
			}
			const usage = stepsOfType(steps, 'usage');
			expect(usage.reduce((sum, u) => sum + u.input + u.output, 0)).toBeGreaterThan(0);
			expect(stepsOfType(steps, 'end').at(-1)?.stop).toBe('stopped');
			const ended = events.find((e) => e.type === 'activation_end' && e.activation === activation);
			expect(ended).toMatchObject({ spoke: true });
		} finally {
			await session.stop();
		}
	});
});
