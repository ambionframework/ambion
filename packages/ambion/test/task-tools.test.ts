import { describe, expect, it } from 'vitest';
import { Activation, type ActivationHost } from '../src/execution/activation.ts';
import { binding, toolsFor } from '../src/execution/tools.ts';
import { defineAgent } from '../src/index.ts';
import type {
	ActivationView,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	TaskResponse,
	TaskSeatRoom,
	ViewResponse,
} from '../src/protocol.ts';

const at = '2026-01-01T09:00:00.000Z';
const agent = defineAgent({
	name: 'owner',
	identity: 'Owner.',
	instructions: 'Use Task tools.',
	model: 'scripted/owner',
});

const activationView: ActivationView = {
	spec: {
		id: 'message:4:owner:1',
		seat: 'owner',
		attempt: 1,
		purpose: { kind: 'respond', message: 4 },
	},
	through: 9,
	context: {
		name: 'origin',
		now: Date.parse(at),
		participants: [],
		messages: [],
		tasks: [],
		reserve: [],
	},
};

const host: ActivationHost = {
	view: async (): Promise<ViewResponse> => ({ view: activationView }),
	renew: async (): Promise<LeaseResponse> => ({ stale: 'unused' }),
	build: async () => {
		throw new Error('unused');
	},
	persist: async () => {},
	emit: () => {},
	now: () => Date.parse(at),
};

function taskRoom(result: TaskResponse): TaskSeatRoom {
	return {
		view: async () => ({ view: activationView }),
		commit: async (): Promise<CommitResult> => ({ refused: 'unused' }),
		lease: async (_request: LeaseRequest): Promise<LeaseResponse> => ({ stale: 'unused' }),
		task: async () => result,
		taskUpdate: async () => result,
		taskSay: async () => result,
	};
}

describe('Task tool result context', () => {
	it('returns the fresh context and acknowledges it only when Pi consumes the result', async () => {
		const activation = new Activation('message:4:owner:1', 'owner', host);
		const tools = toolsFor(
			activationView,
			agent,
			binding(
				activation,
				taskRoom({ task: 'task-1', room: 'working', status: 'open', view: activationView }),
			),
		);
		const taskTool = tools.find((tool) => tool.name === 'task');
		if (taskTool === undefined) throw new Error('Task tool is not available.');

		const result = await taskTool.execute('task-call', {
			text: 'Delegate this work.',
			agents: ['worker'],
		});
		const text = result.content[0];
		if (text?.type !== 'text') throw new Error('Task result has no text.');
		expect(JSON.parse(text.text)).toEqual({
			task: 'task-1',
			room: 'working',
			status: 'open',
			context: activationView.context,
		});
		expect(activation.readThrough).toBe(0);

		activation.providerRequestStarted([{ role: 'toolResult', toolCallId: 'other-call' }]);
		expect(activation.readThrough).toBe(0);
		activation.providerRequestStarted([{ role: 'toolResult', toolCallId: 'task-call' }]);
		expect(activation.readThrough).toBe(9);
	});

	it('renders Task refusals with their latest Task and fresh context', async () => {
		const activation = new Activation('message:4:owner:1', 'owner', host);
		const refusal: TaskResponse = {
			refused: 'The Task changed.',
			task: {
				id: 'task-1',
				text: 'Delegate this work.',
				workingRoom: 'working',
				status: 'open',
				events: [],
			},
			view: activationView,
		};
		const tools = toolsFor(activationView, agent, binding(activation, taskRoom(refusal)));
		const update = tools.find((tool) => tool.name === 'task_update');
		if (update === undefined) throw new Error('Task update tool is not available.');
		await expect(update.execute('update-call', { task: 'task-1', text: 'Retry.' })).rejects.toThrow(
			'"The Task changed."',
		);
		expect(activation.readThrough).toBe(0);
		activation.providerRequestStarted([{ role: 'toolResult', toolCallId: 'update-call' }]);
		expect(activation.readThrough).toBe(9);
	});

	it('refreshes context when a Task-only journal change produces an empty say conflict', async () => {
		const activation = new Activation('message:4:owner:1', 'owner', host);
		const room = taskRoom({
			task: 'task-1',
			room: 'working',
			status: 'open',
			view: activationView,
		});
		room.commit = async () => ({ missed: [] });
		const say = toolsFor(activationView, agent, binding(activation, room))[0];
		if (say === undefined) throw new Error('The response tools have no say tool.');

		await expect(say.execute('say-call', { text: 'A fresh answer.' })).rejects.toThrow(
			'fresh context',
		);
		expect(activation.readThrough).toBe(0);
		activation.providerRequestStarted([{ role: 'toolResult', toolCallId: 'say-call' }]);
		expect(activation.readThrough).toBe(9);
	});
});
