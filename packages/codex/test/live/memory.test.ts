/**
 * Exchange continuity on a real `codex`. Each activation records its
 * thread, and the first activation in a new exchange starts a fresh one. A
 * thread id that Codex cannot resume falls back to a fresh thread, and the
 * seat still speaks. The recorded client proves the resume inside one
 * exchange (`../executor.test.ts`).
 */
import type { PassInput } from '@ambionframework/ambion/hosting';
import { expect, it } from 'vitest';
import { createCodexExecutor } from '../../src/index.ts';
import { lands, roomOf, viewOf } from '../support.ts';
import { errorsIn, live, open, person, saidBy, seat, untilQuiet } from './support.ts';

live('exchange continuity', () => {
	it('records a thread for each activation, and starts a fresh one in a new exchange', async () => {
		const { room, events } = await open('memory', {
			agents: [seat('clerk', { instructions: 'Answer with one say, in one sentence.' })],
		});
		try {
			const visit = await room.visit(person);
			await visit.send({ text: 'Say only "one".' });
			await untilQuiet(room);
			await visit.send({ text: 'Say only "two".' });
			await untilQuiet(room);

			expect(saidBy((await room.read()).messages, 'clerk')).toHaveLength(2);
			const ids = (await room.read()).exchanges.flatMap((exchange) =>
				exchange.activations.flatMap((activation) =>
					activation.session?.harness === 'codex' ? [activation.session.id] : [],
				),
			);
			expect(ids).toHaveLength(2);
			expect(new Set(ids).size).toBe(2);
			expect(errorsIn(events)).toEqual([]);
		} finally {
			await room.stop();
		}
	});

	it('falls back to a fresh thread when the session id is bogus, and still speaks', async () => {
		const definition = seat('gpt');
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
