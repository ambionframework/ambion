/**
 * The workspace tools on a real `codex` and a real model. A seat has no
 * native tool, so it writes a file and runs a command through the workspace
 * tools, over the in-memory backend. The test reads the file back through
 * the workspace port, and checks that the say carries what the command read.
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
	saidBy,
	seat,
	untilQuiet,
} from './support.ts';

const CONTENT = 'ambion-7431';

live('workspace tools', () => {
	it('writes a file and runs a command through the workspace, and says what the command read', async () => {
		const workspace = openWorkspace({ name: 'lab', backend: { bash: memoryBackend() } });
		const {
			room,
			steps: stepsOf,
			events,
		} = await open('tools', {
			agents: [
				seat('writer', {
					instructions: 'Do the work with your workspace tools, then report with one say.',
					bundles: [workspace.tools()],
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({
				text:
					`Write the file note.txt with the one line "${CONTENT}" using the write tool, ` +
					'then run the bash command `cat note.txt`, then say what it printed.',
			});
			await untilQuiet(room);

			const [activation] = activationsOf(events, 'writer');
			const steps = stepsOf(activation ?? '');
			const calls = steps.filter((step) => step.type === 'tool_call');
			const names = calls.map((step) => step.name);
			expect(names).toContain('write');
			expect(names).toContain('bash');
			for (const call of calls) {
				const result = steps.find((step) => step.type === 'tool_result' && step.call === call.call);
				expect(result, `a result for ${call.name}`).toBeDefined();
			}

			// The file is in the workspace, in the home of the seat.
			const note = await workspace.use({ name: 'writer' }, (env) =>
				env.readTextFile('/home/writer/note.txt'),
			);
			expect(note).toMatchObject({ ok: true, value: expect.stringContaining(CONTENT) });

			const said = saidBy((await room.read()).messages, 'writer')
				.map((message) => message.text)
				.join('\n');
			expect(said).toContain(CONTENT);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});
});
