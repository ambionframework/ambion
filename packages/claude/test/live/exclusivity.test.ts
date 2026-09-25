/**
 * The room defines the seat. A seat with no `allowedTools` holds the room
 * tools and no built-in tool. A seat with `allowedTools: ['Read']` reads
 * inside its `cwd` and holds no tool that writes.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { isSpoken } from '../../../ambion/src/index.ts';
import { enter, messagesOf } from '../../../ambion/test/support/room.ts';
import { live, open, person, seat, stepsOfType, untilQuiet, within } from './support.ts';

const CODE = 'TANGO-7731';
const ROOM_TOOLS = ['say', 'seat', 'unseat', 'dismiss'];

/** A directory with a file that holds the code. */
async function directory(): Promise<string> {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), 'ambion-live-tools-')));
	await writeFile(join(cwd, 'notes.txt'), `The gate code is ${CODE}.\n`);
	return cwd;
}

/** Ask one seat one question. Returns its steps and what it said. */
async function ask(prefix: string, definition: ReturnType<typeof seat>, text: string) {
	const { session, steps: stepsOf } = await open(prefix, [definition]);
	try {
		const visit = await enter(session, person);
		const started = new Promise<string>((resolve) => {
			session.subscribe((e) => {
				if (e.type === 'activation_start') resolve(e.activation);
			});
		});
		await visit.send({ text });
		const activation = await within(started, 60_000, 'the activation starting');
		await untilQuiet(session);
		const said = (await messagesOf(session))
			.filter(isSpoken)
			.filter((m) => m.from === definition.name)
			.map((m) => m.text)
			.join('\n');
		return { steps: stepsOf(activation), said };
	} finally {
		await session.stop();
	}
}

live('exclusivity', () => {
	it('a seat with no allowedTools calls no built-in tool', async () => {
		const cwd = await directory();
		try {
			const bare = seat('bare', 'Answers what is asked.', {
				instructions: `
					When asked, run the shell command ls and read notes.txt with any
					tool you have. Answer with one say, in one sentence, that says what
					you could and could not do.
				`,
				cwd,
			});
			const { steps, said } = await ask(
				'bare',
				bare,
				'Run `ls` in a shell, and read notes.txt. What is the gate code?',
			);
			const called = stepsOfType(steps, 'tool_call').map((s) => s.name);
			expect(called.filter((n) => !ROOM_TOOLS.includes(n))).toEqual([]);
			expect(stepsOfType(steps, 'approval')).toEqual([]);
			expect(said).not.toContain(CODE);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("a seat with allowedTools ['Read'] reads inside its cwd and cannot write", async () => {
		const cwd = await directory();
		try {
			const reader = seat('reader', 'Reads notes.', {
				instructions: `
					When asked, read notes.txt with the Read tool. If you are also asked
					to write a file, try any tool you have for it. Then answer with one
					say that quotes the gate code and says whether the write worked.
				`,
				allowedTools: ['Read'],
				cwd,
			});
			const { steps, said } = await ask(
				'reader',
				reader,
				'Read notes.txt and tell me the gate code. Then write the word done to out.txt.',
			);
			const called = stepsOfType(steps, 'tool_call').map((s) => s.name);
			expect(called).toContain('Read');
			expect(called.filter((n) => !ROOM_TOOLS.includes(n) && n !== 'Read')).toEqual([]);
			expect(said).toContain(CODE);
			expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
