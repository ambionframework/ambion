/** A bounded live-model check for same-identity background Task execution. */
import { expect, it } from 'vitest';
import { readRoom } from '../../src/index.ts';
import { messagesOf } from '../support/room.ts';
import { agent, invariants, live, open, person, QUIET_MS, within } from './support.ts';

live('Tasks', () => {
	it('runs a background Task in a cloned same-identity working room and reports it to its owner', async () => {
		const delegate = agent('delegate', {
			identity: 'A planning agent that can execute delegated work.',
			instructions: `
				When a person asks you to delegate work, create exactly one background
				Task with task({ text, agents: ['delegate'] }). The Task text must say
				that the work is complete when you report success. Keep engaging the
				originating room while the Task runs.

				When you are running in a Task working room and see the assignment,
				call task_update for that Task exactly once with status succeeded and
				text stating that the assignment is complete. In the originating room,
				when the final Task notification arrives, acknowledge completion with
				one short say to the person.
			`,
		});
		const { session, runtime, events } = await open('tasks', {
			agents: [delegate],
		});
		try {
			const visit = await session.visit(person);
			const exchange = await visit.send({
				text: 'Please create exactly one background Task using yourself as its only agent. Continue engaging this room while it runs, then tell me briefly when its final completion notification arrives.',
			});
			await within(exchange.waitForClose(), QUIET_MS, 'the Task exchange closing');

			const snapshot = await session.read({ messages: false });
			expect(snapshot.tasks).toHaveLength(1);
			const task = snapshot.tasks[0];
			if (task === undefined) throw new Error('The live Task was not recorded.');
			expect(task.status).toBe('succeeded');

			const working = await readRoom(task.workingRoom, { runtime });
			expect(working.participants.map((participant) => participant.name)).toContain(delegate.name);
			const reports = (await messagesOf(session)).filter(
				(message) => message.kind === 'said' && message.taskId === task.id,
			);
			expect(
				reports.some(
					(message) => message.kind === 'said' && 'to' in message && message.to === delegate.name,
				),
			).toBe(true);
			await invariants(session, events);
		} finally {
			await session.stop();
		}
	});
});
