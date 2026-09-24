/**
 * No steer, on a real `codex`. A message that lands while a turn runs waits.
 * The next pass reads it, and no say commits against a record the seat has
 * not read.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	it('is held, and the next pass reads it', async () => {
		const {
			room,
			steps: stepsOf,
			events,
		} = await open('steer', {
			agents: [
				seat('clerk', {
					instructions:
						'Do what the newest message asks. Report with one say when the record is read to its end.',
					nativeTools: 'codex',
					// Codex runs the command with no sandbox, so keep it out of the checkout.
					workingDirectory: mkdtempSync(join(tmpdir(), 'ambion-codex-steer-')),
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			const running = new Promise<void>((resolve) => {
				room.subscribe((event) => {
					if (event.type === 'tool_execution_start') resolve();
				});
			});
			await visit.send({
				text: 'Run the shell command `sleep 15`, then say "first".',
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
			// Codex takes no steer: no step of the activation records one.
			expect(read.some((step) => step.type === 'steer')).toBe(false);

			// Freshness: every say of the seat comes after the message it read, or names no stale record.
			const said = messages.filter(
				(message) => message.kind === 'said' && message.from === 'clerk',
			);
			expect(said.length).toBeGreaterThan(0);
			expect(said.some((message) => message.seq > (late?.seq ?? Infinity))).toBe(true);
			expect(errorsIn(events).filter((event) => event.type === 'delivery_error')).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
