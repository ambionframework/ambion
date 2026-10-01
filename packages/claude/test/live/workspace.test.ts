/**
 * A Claude seat reaches files and a shell only through the workspace tools.
 * The workspace here is the in-memory just-bash backend. The seat writes a
 * file, edits it, reads it back, and runs one command on it. The model gets
 * no built-in tool of Claude Code for any of these.
 */
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { expect, it } from 'vitest';
import { defineAgent } from '../../../ambion/src/index.ts';
import { enter } from '../../../ambion/test/support/room.ts';
import { claude } from '../../src/index.ts';
import { live, MODEL, open, person, stepsOfType, untilQuiet, within } from './support.ts';

const BUILT_IN = ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'LS'];
const PATH = '/shared/token.txt';

live('workspace', () => {
	it('a seat writes, edits, reads, and runs a command through the workspace tools only', async () => {
		const backend = memoryBackend();
		const drive = openWorkspace({ name: 'claude-live', backend: { bash: backend } });
		const clerk = defineAgent({
			name: 'clerk',
			identity: 'Keeps the shared notes.',
			executor: claude({
				model: MODEL,
				instructions: `
					When asked, use the workspace tools in this order, and no other tool.
					First write the file ${PATH} with the single line "token: ALPHA-5521".
					Then edit that file and change ALPHA-5521 to BRAVO-5521. Then read the
					file back. Then run the command "wc -c ${PATH}" with bash, and wait
					for it to finish. At last say, in one sentence, what the file holds
					and what wc printed.
				`,
				bundles: [drive.tools()],
			}),
		});
		const { session, steps: stepsOf } = await open('workspace', [clerk]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start') resolve(e.activation);
				});
			});
			await visit.send({ text: 'Please do the notes task now.' });
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);
			const steps = stepsOf(activation);

			const called = stepsOfType(steps, 'tool_call').map((step) => step.name);
			for (const name of ['write', 'edit', 'read', 'bash']) expect(called).toContain(name);
			expect(called.filter((name) => BUILT_IN.includes(name))).toEqual([]);

			// The workspace holds the edited file. The host filesystem holds none of it.
			const files = await backend.readFiles();
			expect(files.find((file) => file.path === PATH)?.text).toContain('BRAVO-5521');
			expect(files.find((file) => file.path === PATH)?.text).not.toContain('ALPHA-5521');

			// The session holds the room tools and the workspace tools, and no built-in tool.
			const [harness] = stepsOfType(steps, 'harness');
			expect(harness?.tools.filter((name) => BUILT_IN.includes(name))).toEqual([]);
			for (const name of ['say', 'write', 'edit', 'read', 'bash'])
				expect(harness?.tools).toContain(name);
		} finally {
			await session.stop();
			await drive.dispose();
		}
	});
});
