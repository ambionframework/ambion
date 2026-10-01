/**
 * The room defines the seat. A Claude seat holds the room tools and the
 * tools of its definition. It holds no built-in tool of Claude Code, and the
 * session step of its session says so.
 */

import { expect, it } from 'vitest';
import { isSaid } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const ROOM_TOOLS = ['say', 'schedule', 'seat', 'unseat', 'dismiss', 'recall'];

live('exclusivity', () => {
	it('a seat calls no built-in tool, and its session holds the room tools only', async () => {
		const bare = seat('bare', 'Answers what is asked.', {
			instructions: `
				When asked, run the shell command ls and read notes.txt with any
				tool you have. Answer with one say, in one sentence, that says what
				you could and could not do.
			`,
		});
		const { session, steps: stepsOf } = await open('bare', [bare]);
		try {
			const visit = await enter(session, person);
			const started = new Promise<string>((resolve) => {
				session.subscribe((e) => {
					if (e.type === 'activation_start') resolve(e.activation);
				});
			});
			await visit.send({ text: 'Run `ls` in a shell, and read notes.txt. What is in it?' });
			const activation = await within(started, 60_000, 'the activation starting');
			await untilQuiet(session);
			const steps = stepsOf(activation);
			const called = stepsOfType(steps, 'tool_call').map((s) => s.name);
			expect(called.filter((n) => !ROOM_TOOLS.includes(n))).toEqual([]);
			const [opened] = stepsOfType(steps, 'session');
			expect(new Set(opened?.tools)).toEqual(new Set(ROOM_TOOLS));
			const said = (await messagesOf(session))
				.filter(isSaid)
				.filter((m) => m.from === 'bare')
				.map((m) => m.text);
			expect(said.length).toBeGreaterThan(0);
		} finally {
			await session.stop();
		}
	});
});
