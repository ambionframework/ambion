/**
 * Memory modes on a real `codex`. A seat with `memory: 'seat'` resumes its
 * thread, so a later activation answers from what the thread holds and the
 * record does not. A thread id that Codex cannot resume falls back to a
 * fresh thread, and the seat still speaks.
 */
import type { PassInput } from '@ambionframework/ambion/hosting';
import { expect, it } from 'vitest';
import { createCodexExecutor } from '../../src/index.ts';
import { lands, roomOf, viewOf } from '../support.ts';
import { errorsIn, live, open, person, saidBy, seat, untilQuiet } from './support.ts';

live('memory seat', () => {
	it('resumes the thread in the second activation and answers from the first', async () => {
		const { room, events } = await open('memory', {
			agents: [
				seat('clerk', {
					memory: 'seat',
					nativeTools: 'codex',
					sandboxMode: 'workspace-write',
					instructions:
						'Use the shell for arithmetic. Report with one say, and say only what was asked.',
				}),
			],
		});
		try {
			const visit = await room.visit(person);
			// The result of the command reaches the thread and never the record.
			await visit.send({
				text: 'Run the shell command `echo $((6*7*11))`. Then say only "done".',
			});
			await untilQuiet(room);
			await visit.send({
				text: 'Which number did the shell command print earlier? Say only the number.',
			});
			await untilQuiet(room);

			const said = saidBy((await room.read()).messages, 'clerk');
			expect(said.at(-1)?.text).toContain('462');
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});

	it('falls back to a fresh thread when the session id is bogus, and still speaks', async () => {
		const definition = seat('gpt', { memory: 'seat' });
		const { room, commits } = roomOf(lands);
		const view = viewOf();
		const bogus = {
			...view,
			spec: {
				...view.spec,
				resume: { harness: 'codex', id: '00000000-0000-0000-0000-000000000000' },
			},
		};
		const session = createCodexExecutor({ definition }).open({
			id: view.spec.id,
			room,
			emit: () => {},
			trace: {
				startPass: () => {},
				record: () => {},
				usage: () => undefined,
				close: async () => {},
			},
		});
		try {
			const result = await session.pass({ kind: 'view', view: bogus } as PassInput);
			expect(result).toEqual({ failed: false });
			expect(commits.some((request) => request.intent.kind === 'said')).toBe(true);
			expect(session.session?.harness).toBe('codex');
			expect(session.session?.id).not.toBe('00000000-0000-0000-0000-000000000000');
		} finally {
			session.close?.();
		}
	});
});
