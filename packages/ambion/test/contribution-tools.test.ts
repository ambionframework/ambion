import type { SessionOpener } from '@ambionframework/pi-journal';
import { describe, expect, it, vi } from 'vitest';
import { Activation, type PiExecutorOptions } from '../src/execution/activation.ts';
import { binding, toolsFor } from '../src/execution/tools.ts';
import type {
	ActivationView,
	CommitRequest,
	CommitResult,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '../src/hosting.ts';
import { type AgentDefinition, defineAgent, pi } from '../src/index.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Writes room contributions.',
	executor: pi({ instructions: 'Use the room tools.', model: 'scripted/worker' }),
});

const unusedRoom: RoomProtocol = {
	view: async (): Promise<ViewResponse> => ({ stale: 'unused' }),
	commit: async (): Promise<CommitResult> => ({ stale: 'unused' }),
	lease: async (): Promise<LeaseResponse> => ({ stale: 'unused' }),
};

function executorOptions(definition: AgentDefinition): PiExecutorOptions {
	return {
		definition,
		model: async () => {
			throw new Error('unused');
		},
		stream: () => {
			throw new Error('unused');
		},
		transcripts: {
			open: async () => {
				throw new Error('unused');
			},
		} as SessionOpener,
		room: 'room',
		now: () => 0,
	};
}

function activationFor(id: string, definition: AgentDefinition): Activation {
	return new Activation(
		{ id, room: unusedRoom, emit: () => {} },
		executorOptions(definition),
		() => {
			throw new Error('unused');
		},
	);
}

function view(purpose: ActivationView['spec']['purpose']): ActivationView {
	return {
		spec: { id: 'activation', seat: worker.name, attempt: 1, purpose },
		through: purpose.kind === 'summarize' ? purpose.through : 0,
		context: { name: 'room', now: 0, participants: [], messages: [], reserve: [] },
	};
}

function roomThatCommits(commits: CommitRequest[], responses: CommitResult[]): RoomProtocol {
	return {
		view: async () => ({ stale: 'unused' }),
		commit: async (request) => {
			commits.push(request);
			const response = responses.shift();
			if (response === undefined) throw new Error('No response was prepared.');
			return response;
		},
		lease: async (_request: LeaseRequest): Promise<LeaseResponse> => ({ stale: 'unused' }),
	};
}

describe('contribution tools', () => {
	it('keeps a refused blank open, then accepts a corrected retry under the same key', async () => {
		const commits: CommitRequest[] = [];
		const activation = activationFor('message:0:worker:1', worker);
		const abort = vi.spyOn(activation, 'abort');
		const acknowledge = vi.spyOn(activation, 'acknowledgeThrough');
		const tool = toolsFor(
			view({ kind: 'respond', message: 0 }),
			worker,
			binding(
				activation,
				roomThatCommits(commits, [
					{ refused: 'The message is empty. Say something, or end your turn instead.' },
					{
						committed: {
							kind: 'said',
							seq: 1,
							at: '2026-01-01T00:00:00.000Z',
							from: worker.name,
							text: 'A useful answer.',
						},
					},
				]),
			),
		)[0];
		if (tool === undefined) throw new Error('The response tools have no say tool.');

		await expect(tool.execute('same-key', { text: '   ' })).rejects.toThrow(
			'The message is empty. Say something, or end your turn instead.',
		);
		expect(abort).not.toHaveBeenCalled();
		expect(acknowledge).not.toHaveBeenCalled();

		await expect(tool.execute('same-key', { text: '  A useful answer.  ' })).resolves.toMatchObject(
			{
				content: [{ text: 'delivered' }],
			},
		);
		expect(abort).not.toHaveBeenCalled();
		expect(acknowledge).toHaveBeenCalledWith(1);
		expect(commits.map(({ key, intent }) => ({ key, intent }))).toEqual([
			{ key: 'same-key', intent: { kind: 'said', text: '' } },
			{ key: 'same-key', intent: { kind: 'said', text: 'A useful answer.' } },
		]);
	});

	it('terminates after a closing contribution lands', async () => {
		const commits: CommitRequest[] = [];
		const activation = activationFor('closed:4:worker:1', worker);
		const abort = vi.spyOn(activation, 'abort');
		const acknowledge = vi.spyOn(activation, 'acknowledgeThrough');
		const tool = toolsFor(
			view({ kind: 'summarize', exchange: 2, person: 'priya', through: 4 }),
			worker,
			binding(
				activation,
				roomThatCommits(commits, [
					{ refused: 'The message is empty. Say something, or end your turn instead.' },
					{
						committed: {
							kind: 'summary',
							seq: 5,
							at: '2026-01-01T00:00:00.000Z',
							from: worker.name,
							to: 'priya',
							text: 'The exchange is complete.',
							covers: { from: 2, through: 4 },
						},
					},
				]),
			),
		)[0];
		if (tool === undefined) throw new Error('The summary tools have no say tool.');

		await expect(tool.execute('closing-key', { to: 'priya', text: ' \t' })).rejects.toThrow(
			'The message is empty. Say something, or end your turn instead.',
		);
		expect(abort).not.toHaveBeenCalled();
		expect(acknowledge).not.toHaveBeenCalled();

		await expect(
			tool.execute('closing-key', { to: ' priya ', text: '  The exchange is complete.  ' }),
		).resolves.toMatchObject({ content: [{ text: 'delivered' }], terminate: true });
		expect(commits).toHaveLength(2);
		expect(commits[0]).toMatchObject({
			activation: 'closed:4:worker:1',
			key: 'closing-key',
			intent: { kind: 'said', to: 'priya', text: '' },
		});
		expect(commits[1]).toMatchObject({
			activation: 'closed:4:worker:1',
			key: 'closing-key',
			intent: { kind: 'said', to: 'priya', text: 'The exchange is complete.' },
		});
	});
});
