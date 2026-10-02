/**
 * A steer, on a real `codex`. A message that lands while a turn runs goes to
 * `turn/steer`. The model reads it in the same turn, so the activation needs
 * one pass, and no say commits against a record the seat has not read.
 */
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { expect, it } from 'vitest';
import {
	activationsOf,
	errorsIn,
	live,
	open,
	person,
	seat,
	untilQuiet,
	within,
} from './support.ts';

live('a message during a turn', () => {
	it('is steered into the live turn, and the same pass reads it', async () => {
		const {
			room,
			steps: stepsOf,
			events,
		} = await open('steer', {
			agents: [
				seat('clerk', {
					instructions:
						'Do what the newest message asks. Report with one say when the record is read to its end.',
					// The workspace bash tool runs the command in memory, behind the workspace port.
					bundles: [openWorkspace({ name: 'steer', backend: { bash: memoryBackend() } }).tools()],
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			const running = new Promise<void>((resolve) => {
				room.subscribe((event) => {
					if (event.type === 'tool_call') resolve();
				});
			});
			await visit.send({
				text: 'Run the bash command `sleep 15`, then say "first".',
			});
			await within(running, 120_000, 'the first command starting');
			const second = await visit.send({ text: 'Also say the word "tangerine".' });
			await untilQuiet(room);

			const messages = (await room.read()).messages;
			const late = messages.find(
				(message) =>
					message.kind === 'said' &&
					message.text.includes('tangerine') &&
					message.from === person.name,
			);
			expect(late, 'the second message is on the record').toBeDefined();
			expect(second).toBeDefined();

			const [activation] = activationsOf(events, 'clerk');
			const read = stepsOf(activation ?? '');
			// Codex takes the line into the turn: the echo of the line tells the core, and one pass reads it.
			const steers = read.filter((step) => step.type === 'steer');
			expect(steers).toEqual([expect.objectContaining({ seq: late?.seq, consumed: true })]);
			expect(read.filter((step) => step.type === 'pass')).toHaveLength(1);

			// Freshness: every say of the seat comes after the message it read, or names no stale record.
			const said = messages.filter(
				(message) => message.kind === 'said' && message.from === 'clerk',
			);
			expect(said.length).toBeGreaterThan(0);
			expect(said.some((message) => message.seq > (late?.seq ?? Infinity))).toBe(true);
			expect(errorsIn(events).filter((event) => event.type === 'port_error')).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
