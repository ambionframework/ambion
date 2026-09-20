import type { SessionOpener } from '@ambionframework/pi-journal';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { Activation, type PiExecutorOptions } from '../src/execution/activation.ts';
import { binding, toolsFor } from '../src/execution/tools.ts';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	Intent,
	LeaseRequest,
	LeaseResponse,
	RoomProtocol,
	ViewResponse,
} from '../src/hosting.ts';
import {
	type AgentDefinition,
	defineAgent,
	defineTool,
	pi,
	type ToolContext,
} from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { activationSpec } from '../src/room/activation.ts';
import { foldRoom } from '../src/room/fold.ts';
import { viewOf } from '../src/room/view.ts';

const worker = defineAgent({
	name: 'worker',
	identity: 'Works on room decisions.',
	executor: pi({
		instructions: 'Use the tool that the room gives you.',
		model: 'scripted/assistant',
		tools: [
			defineTool({
				name: 'record_decision',
				description: 'Record a private decision.',
				parameters: Type.Object({}),
				execute: () => 'recorded',
			}),
		],
	}),
});

// @ts-expect-error The room has no summary intent; closing work uses said.
const removedSummaryIntent: Intent = { kind: 'summary', text: 'x' };
void removedSummaryIntent;

const oldAuthority: ActivationSpec = {
	id: 'message:4:worker:1',
	seat: 'worker',
	attempt: 1,
	purpose: { kind: 'respond', message: 4 },
	// @ts-expect-error Activation authority no longer carries a grant field.
	grant: { kind: 'say', tool: 'say' },
};
void oldAuthority;

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
		spec: { id: 'activation', seat: 'worker', attempt: 1, purpose },
		through: purpose.kind === 'summarize' ? purpose.through : 4,
		context: { name: 'room', now: 0, participants: [], messages: [], reserve: [] },
	};
}

function roomThatCommits(commits: CommitRequest[]): RoomProtocol {
	return {
		view: async () => ({ stale: 'unused' }),
		commit: async (request): Promise<CommitResult> => {
			commits.push(request);
			return {
				committed: {
					kind: 'said',
					seq: 5,
					at: '2026-01-01T00:00:00.000Z',
					from: 'worker',
					text: 'The room stamped this.',
				},
			};
		},
		lease: async (_request: LeaseRequest): Promise<LeaseResponse> => ({
			stale: 'unused',
		}),
	};
}

const names = (tools: readonly AgentTool[]) => tools.map((tool) => tool.name);

describe('executor tool authority', () => {
	it('binds only the tool named by each activation purpose', () => {
		const activation = activationFor('activation', worker);
		const room = roomThatCommits([]);
		const held = binding(activation, room);

		expect(names(toolsFor(view({ kind: 'respond', message: 4 }), worker, held))).toEqual([
			'say',
			'seat',
			'unseat',
			'record_decision',
		]);
		expect(
			names(
				toolsFor(
					view({ kind: 'summarize', exchange: 4, person: 'priya', through: 7 }),
					worker,
					held,
				),
			),
		).toEqual(['say']);
	});

	it('sends summary text only and lets the room stamp recipient and range', async () => {
		const commits: CommitRequest[] = [];
		const activation = activationFor('closed:4:worker:1', worker);
		const tools = toolsFor(
			view({ kind: 'summarize', exchange: 4, person: 'priya', through: 7 }),
			worker,
			binding(activation, roomThatCommits(commits)),
		);
		const summary = tools[0];
		if (summary === undefined) throw new Error('The summarize purpose has no tool.');
		const result = await summary.execute('summary-call', {
			to: 'priya',
			text: '  A short result.  ',
		});

		expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
		expect(commits).toEqual([
			{
				activation: 'closed:4:worker:1',
				key: 'summary-call',
				intent: { kind: 'said', to: 'priya', text: 'A short result.' },
			},
		]);
		expect(activation.readThrough).toBe(0);
	});

	it('does not mark context consumed for membership or an unchanged membership result', async () => {
		const activation = activationFor('message:4:worker:1', worker);
		const commits: CommitRequest[] = [];
		const room: RoomProtocol = {
			view: async () => ({ stale: 'unused' }),
			commit: async (request) => {
				commits.push(request);
				return { unchanged: { kind: 'seated', name: 'surveyor' } };
			},
			lease: async () => ({ stale: 'unused' }),
		};
		const seat = toolsFor(
			view({ kind: 'respond', message: 4 }),
			worker,
			binding(activation, room),
		)[1];
		if (seat === undefined) throw new Error('The response tools have no seat tool.');

		await expect(seat.execute('seat-call', { name: 'surveyor' })).resolves.toMatchObject({
			content: [{ text: 'delivered' }],
		});
		expect(commits).toEqual([
			{
				activation: 'message:4:worker:1',
				key: 'seat-call',
				intent: { kind: 'seated', name: 'surveyor' },
			},
		]);
		expect(activation.readThrough).toBe(0);
	});

	it('acknowledges a live response boundary but fixes a summary at its close', () => {
		const at = '2026-01-01T00:00:00.000Z';
		const entries: Entry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					version: 2,
					summary: 'worker',
					agents: [
						{ name: 'worker', identity: 'A.', attention: 'broadcast' },
						{ name: 'product', identity: 'P.', attention: 'broadcast' },
					],
					available: [],
					at,
				},
			},
			{
				kind: 'message',
				seq: 2,
				body: { kind: 'arrived', at, subject: 'priya', identity: 'P.' },
			},
			{
				kind: 'message',
				seq: 3,
				body: { kind: 'said', at, from: 'priya', text: 'Question.' },
			},
			{
				kind: 'close',
				seq: 4,
				body: { owner: 'priya', from: 3, through: 3, at, summary: 'worker' },
			},
			{
				kind: 'message',
				seq: 5,
				body: { kind: 'said', at, from: 'priya', text: 'Later.', wakes: ['product'] },
			},
			{
				kind: 'message',
				seq: 6,
				body: { kind: 'said', at, from: 'priya', text: 'Latest.', wakes: ['product'] },
			},
		];
		const state = foldRoom(entries, { backoff: () => 0 });
		const facts = {
			name: 'room',
			now: Date.parse(at),
			state,
			live: new Map<string, string[]>(),
			messagesSince: () => 0,
		};
		const summary = activationSpec('closed:3:worker:1', state);
		const response = activationSpec('message:5:product:1', state);
		if (summary === undefined || response === undefined)
			throw new Error('Expected valid authorities.');

		const summaryView = viewOf(summary, facts);
		const responseView = viewOf(response, facts);
		expect(summaryView.through).toBe(3);
		expect(summaryView.context.messages).not.toContainEqual(
			expect.objectContaining({ text: 'Latest.' }),
		);
		expect(responseView.through).toBe(6);
		expect(responseView.context.messages).toContainEqual(
			expect.objectContaining({ text: 'Latest.' }),
		);
	});

	it('hands a domain tool the room, the activation, and the exchange from the view', async () => {
		const seen: ToolContext[] = [];
		const capturing = defineAgent({
			name: 'worker',
			identity: 'Works on room decisions.',
			executor: pi({
				instructions: 'Use the tool that the room gives you.',
				model: 'scripted/assistant',
				tools: [
					defineTool({
						name: 'record_decision',
						description: 'Record a private decision.',
						parameters: Type.Object({}),
						execute: (_params, ctx) => {
							seen.push(ctx);
							return 'recorded';
						},
					}),
				],
			}),
		});
		const base = view({ kind: 'respond', message: 4 });
		const open: ActivationView = {
			...base,
			spec: { ...base.spec, id: 'message:4:worker:1' },
			context: { ...base.context, exchange: { owner: 'priya', from: 4 } },
		};
		const held = binding(activationFor('message:4:worker:1', capturing), unusedRoom);
		await toolsFor(open, capturing, held)[3]?.execute('call-1', {});
		await toolsFor({ ...open, context: { ...base.context } }, capturing, held)[3]?.execute(
			'call-2',
			{},
		);

		const [first, second] = seen;
		expect(first).toMatchObject({
			callId: 'call-1',
			room: 'room',
			activation: 'message:4:worker:1',
			exchange: { owner: 'priya', from: 4 },
		});
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first?.exchange)).toBe(true);
		expect(second).toMatchObject({ room: 'room', activation: 'message:4:worker:1' });
		expect(second).not.toHaveProperty('exchange');
	});
});
