/**
 * A message that lands during a pass joins the live pass. The SDK echoes it
 * back, and `readThrough` advances on that echo, so the say that follows
 * commits against the whole record.
 */
import { Type } from 'typebox';
import { expect, it } from 'vitest';
import { defineTool, isSaid, type TraceStep } from '../../../ambion/src/index.ts';
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
					if (e.type === 'tool_call' && e.name === 'check_calendar') resolve(e.activation);
				});
			});
			await visit.send({ text: 'When can we pour the slab?' });
			const activation = await within(started, 60_000, 'the tool starting');
			await visit.send({ text: 'Also: the inspector visits on Friday.' });
			await untilQuiet(session);

			const messages = await messagesOf(session);
			const second = messages.filter(isSaid).filter((m) => m.from === person.name)[1];
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

	it('a message sent during the final answer runs as a turn of its own, and its say commits', async () => {
		const clerk = seat('clerk', 'Site clerk. Answers scheduling questions.', {
			instructions: `
				Answer a question with one say, in one sentence. After that say, close
				with a note in plain text: several paragraphs on how
				you reached the date. When a person adds a line, answer it with one
				more say, in one sentence.
			`,
		});
		const { session, events, steps: stepsOf } = await open('steer-final', [clerk]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start') resolve(e.activation);
				});
			});
			await visit.send({ text: 'When can we pour the slab? Explain the cure times first.' });
			const activation = await started;
			// The final answer starts when the result of the first say returns to the model.
			const deadline = Date.now() + 60_000;
			while (!finalAnswerStarts(stepsOf(activation))) {
				if (Date.now() > deadline) throw new Error('The answer did not start streaming.');
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			await visit.send({ text: 'Also: the inspector visits on Friday.' });
			await untilQuiet(session);

			const messages = await messagesOf(session);
			const second = messages.filter(isSaid).filter((m) => m.from === person.name)[1];
			expect(second).toBeDefined();
			const steps = stepsOf(activation);
			expect(stepsOfType(steps, 'steer')).toContainEqual(
				expect.objectContaining({ seq: second?.seq, consumed: true }),
			);
			// A say landed after the steered line: the turn that answers it was not cut.
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

/**
 * Whether the result of the first committed say has returned to the model.
 * The model then streams its closing note. The trace joins the deltas of a
 * text block and logs only the whole block, so no open text step shows.
 */
function finalAnswerStarts(steps: readonly TraceStep[]): boolean {
	const said = steps.find(
		(step) => step.type === 'room' && step.intent.kind === 'said' && step.result === 'committed',
	);
	return (
		said?.type === 'room' &&
		steps.some((step) => step.type === 'tool_result' && step.call === said.call)
	);
}
