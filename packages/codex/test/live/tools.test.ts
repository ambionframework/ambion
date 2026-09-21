/**
 * The built-in tools of Codex on a real `codex`: a command and a file change
 * become tool steps, and the next ordinary say cites the changed path.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
	activationsOf,
	errorsIn,
	live,
	open,
	person,
	saidBy,
	seat,
	stepsOf,
	untilQuiet,
} from './support.ts';

live('command and file change', () => {
	it('shows both as tool steps, and cites the changed path in the next say', async () => {
		const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ambion-codex-live-')));
		const { room, name, runtime, events } = await open('tools', {
			agents: [
				seat('writer', {
					instructions:
						'Do the work in the working directory with your own tools, then report with one say.',
					sandboxMode: 'workspace-write',
					workingDirectory: directory,
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({
				text:
					'Create the file note.txt with the one line "ambion" using a file edit, ' +
					'then run the shell command `cat note.txt`, then say what it printed.',
			});
			await untilQuiet(room);

			const [activation] = activationsOf(events, 'writer');
			const steps = await stepsOf(name, activation ?? '', runtime);
			const calls = steps.filter((step) => step.type === 'tool_call');
			const names = calls.map((step) => step.name);
			expect(names).toContain('file_change');
			expect(names).toContain('command');
			for (const call of calls.filter((step) => step.name !== 'say')) {
				const result = steps.find((step) => step.type === 'tool_result' && step.call === call.call);
				expect(result, `a result for ${call.name}`).toBeDefined();
			}

			const messages = (await room.read()).messages;
			const refs = saidBy(messages, 'writer').flatMap((message) => message.refs ?? []);
			expect(refs.some((ref) => ref.endsWith('note.txt'))).toBe(true);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
