/**
 * The kernel has no default executor. A room with no execution still runs
 * its people and its record. A seat the room wakes fails at once, and the
 * failure is permanent: a retry cannot supply an execution.
 */
import { describe, expect, it } from 'vitest';
import type { AgentExecutor, ExecutionEvent } from '../src/index.ts';
import { defineAgent, startRoom } from '../src/index.ts';
import { andrei, collect, roomName, waitForRoom } from './support/room.ts';

/** An executor of a family no execution serves. The kernel reads none of its fields. */
const executor: AgentExecutor = { kind: 'none', instructions: 'answer', tools: [] };

const worker = defineAgent({ name: 'worker', identity: 'Answers.', executor });

describe('a room with no execution', () => {
	it('fails the activation of a woken seat with a permanent no_execution error', async () => {
		const room = await startRoom({ name: roomName('no-execution'), agents: [worker] });
		const events = collect(room);
		try {
			const visit = await room.visit(andrei);
			await visit.send({ text: 'Anybody there?' });
			await waitForRoom(room);
			const failures = events.filter(
				(event): event is Extract<ExecutionEvent, { type: 'error' }> => event.type === 'error',
			);
			expect(failures.length).toBeGreaterThan(0);
			expect(failures[0]?.cause).toBe('permanent');
			expect(failures[0]?.agent).toBe('worker');
			expect(failures[0]?.error).toMatchObject({ code: 'no_execution' });
		} finally {
			await room.stop();
		}
	});
});
