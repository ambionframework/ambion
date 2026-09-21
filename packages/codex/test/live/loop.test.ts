/**
 * The loop on a real `codex`: a seat answers through `say`, the room tools
 * run without an approval error, and the activation reports its usage and
 * its steps.
 */
import { isSpoken } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { errorsIn, live, open, person, saidBy, seat, stepsOf, untilQuiet } from './support.ts';

live('the loop', () => {
	it('answers through say, with the room tools approved and the usage counted', async () => {
		const { room, name, runtime, events } = await open('loop', {
			agents: [seat('clerk', { instructions: 'Answer through one say, in one sentence.' })],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ text: 'What is 2 plus 2? Answer with the number.' });
			await untilQuiet(room);

			// (a) The seat answered through say, and the room recorded it.
			const messages = (await room.read()).messages;
			const said = saidBy(messages, 'clerk');
			expect(said.length).toBeGreaterThanOrEqual(1);
			expect(said.map((message) => message.text).join(' ')).toContain('4');
			const ended = events.filter((event) => event.type === 'activation_end');
			expect(ended).toContainEqual(expect.objectContaining({ agent: 'clerk', spoke: true }));
			expect(errorsIn(events)).toEqual([]);

			// (b) No tool result carries an approval error.
			const activation = ended.find((event) => event.agent === 'clerk')?.activation ?? '';
			const steps = await stepsOf(name, activation, runtime);
			const results = steps.filter((step) => step.type === 'tool_result');
			expect(steps.some((step) => step.type === 'tool_call' && step.name === 'say')).toBe(true);
			for (const result of results) {
				expect(result.error ?? '').not.toMatch(/approval/i);
			}

			// (d) One activation reports usage above zero, and its steps can be read.
			const usage = ended.find((event) => event.agent === 'clerk')?.usage;
			expect((usage?.input ?? 0) + (usage?.output ?? 0)).toBeGreaterThan(0);
			expect(steps.length).toBeGreaterThan(0);
			expect(messages.some(isSpoken)).toBe(true);
		} finally {
			await room.stop();
		}
	});
});
