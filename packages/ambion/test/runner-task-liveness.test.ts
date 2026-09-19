/** Task calls retain the executor's timeout and cancellation boundaries. */
import { describe, expect, it } from 'vitest';
import { createRuntime, defineAgent, type RoomNotification } from '../src/index.ts';
import { AgentRunner, type LeaseRequest, type TaskSeatRoom } from '../src/transport.ts';
import { fakeClock } from './support/clock.ts';
import { tick } from './support/room.ts';
import { callTool, quiet, scripted } from './support/scripted.ts';

const cases = [
	{ tool: 'task', operation: 'task', args: { text: 'Work.', agents: ['worker'] } },
	{ tool: 'task_update', operation: 'task_update', args: { task: 'task-one', text: 'Progress.' } },
	{ tool: 'say', operation: 'task_say', args: { task: 'task-one', text: 'Continue.' } },
] as const;

async function until(done: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !done(); attempt += 1) await tick();
	if (!done()) throw new Error('The Task call did not start.');
}

function fixture(testCase: (typeof cases)[number]) {
	const clock = fakeClock(0);
	let called = false;
	let requested = false;
	const events: RoomNotification[] = [];
	const leases: LeaseRequest[] = [];
	const runtime = createRuntime({
		clock,
		call: { timeout: 10 },
		stream: scripted(() => {
			if (requested) return quiet();
			requested = true;
			return callTool(testCase.tool, testCase.args);
		}),
	});
	const pending = () => {
		called = true;
		return new Promise<never>(() => {});
	};
	const room: TaskSeatRoom = {
		async view(id) {
			return {
				view: {
					spec: { id, seat: 'owner', attempt: 1, purpose: { kind: 'respond', message: 1 } },
					through: 1,
					context: { name: 'origin', now: 0, participants: [], messages: [], reserve: [] },
				},
			};
		},
		async commit() {
			return { refused: 'Use the Task.' };
		},
		async lease(request) {
			leases.push(request);
			return { ok: { expiresAt: clock.now() + 100, lastSeq: 1 } };
		},
		task: pending,
		taskUpdate: pending,
		taskSay: pending,
	};
	const actor = new AgentRunner(room, {
		clock,
		call: runtime.call,
		definition: defineAgent({
			name: 'owner',
			identity: 'Owner.',
			instructions: 'Work.',
			model: 'scripted/owner',
		}),
		room: 'origin',
		seat: 'owner',
		transcripts: runtime.transcripts,
		stream: runtime.stream,
		model: runtime.model,
		emit: (event) => events.push(event),
	});
	return { actor, clock, events, leases, called: () => called };
}

describe.each(cases)('$operation executor boundary', (testCase) => {
	it('times out an unanswered Task call and releases the activation', async () => {
		const { actor, clock, events, leases, called } = fixture(testCase);
		const run = actor.run('message:1:owner:1');
		await until(called);
		await clock.advance(10);
		await run;
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'delivery_error', operation: testCase.operation }),
		);
		expect(leases).toContainEqual(expect.objectContaining({ operation: 'release' }));
	});

	it('cuts an unanswered Task call without waiting for its timeout', async () => {
		const { actor, events, called } = fixture(testCase);
		const run = actor.run('message:1:owner:1');
		await until(called);
		await actor.cut('message:1:owner:1');
		await run;
		expect(events.filter((event) => event.type === 'delivery_error')).toEqual([]);
	});
});
