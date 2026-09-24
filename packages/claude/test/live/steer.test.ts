/**
 * A message that lands during a pass joins the live pass. The SDK echoes it
 * back, and `readThrough` advances on that echo, so the say that follows
 * commits against the whole record.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { defineTool, isSpoken } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const HOLD_MS = 8_000;

/** A tool that keeps the pass open long enough for a second message to land. */
const hold = defineTool({
	name: 'check_calendar',
	description: 'Look the date up in the site calendar. Takes a few seconds.',
	parameters: Type.Object({ topic: Type.String() }),
	execute: async () => {
		await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
		return 'The calendar is free on Saturday.';
	},
});

live('steer', () => {
	it('a message sent during a pass joins that pass, and the say commits fresh', async () => {
		const clerk = seat('clerk', 'Site clerk. Answers scheduling questions.', {
			instructions: `
				When somebody asks a question, call check_calendar first. After it
				returns, read the record again for anything new, then answer with one
				say that covers everything the person has asked, in one sentence.
			`,
			tools: [hold],
		});
		const { session, events, steps: stepsOf } = await open('steer', [clerk]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'tool_execution_start' && e.toolName === 'check_calendar')
						resolve(e.activation);
				});
			});
			await visit.send({ text: 'When can we pour the slab?' });
			const activation = await within(started, 60_000, 'the tool starting');
			await visit.send({ text: 'Also: the inspector visits on Friday.' });
			await untilQuiet(session);

			const messages = await messagesOf(session);
			const second = messages.filter(isSpoken).filter((m) => m.from === person.name)[1];
			expect(second).toBeDefined();
			const steps = stepsOf(activation);
			expect(stepsOfType(steps, 'steer')).toContainEqual(
				expect.objectContaining({ seq: second?.seq, consumed: true }),
			);
			// The say landed after the steered line, against a record that held it.
			const says = stepsOfType(steps, 'room').filter((s) => s.intent.kind === 'said');
			expect(says.some((s) => s.result === 'committed' && (s.seq ?? 0) > (second?.seq ?? 0))).toBe(
				true,
			);
			expect(events.filter((e) => e.type === 'error')).toEqual([]);
		} finally {
			await session.stop();
		}
	});
});
