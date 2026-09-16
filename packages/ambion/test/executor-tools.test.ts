import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { describe, expect, it } from 'vitest';
import { defineAgent, defineTool } from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { activationSpec } from '../src/room/activation.ts';
import { foldRoom } from '../src/room/fold.ts';
import { viewOf } from '../src/room/view.ts';
import { Activation, type ActivationHost } from '../src/seat/activation.ts';
import { binding, toolsFor } from '../src/seat/tools.ts';
import type {
	ActivationSpec,
	ActivationView,
	CommitRequest,
	CommitResult,
	Intent,
	LeaseRequest,
	LeaseResponse,
	SeatRoom,
	ViewResponse,
} from '../src/transport.ts';
import type { RoomNotification } from '../src/types.ts';

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes room decisions.',
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
});

// @ts-expect-error The room stamps summary recipient and range metadata.
const summaryWithRecipient: Intent = { kind: 'summary', text: 'x', to: 'priya' };
void summaryWithRecipient;

const oldAuthority: ActivationSpec = {
	id: 'message:4:assistant:1',
	seat: 'assistant',
	attempt: 1,
	purpose: { kind: 'respond', message: 4 },
	// @ts-expect-error Activation authority no longer carries a grant field.
	grant: { kind: 'say', tool: 'say' },
};
void oldAuthority;

const host: ActivationHost = {
	view: async (): Promise<ViewResponse> => ({ stale: 'unused' }),
	renew: async (): Promise<LeaseResponse> => ({ stale: 'unused' }),
	build: async () => {
		throw new Error('unused');
	},
	persist: async () => {},
	emit: (_event: RoomNotification) => {},
	now: () => 0,
};

function view(purpose: ActivationView['spec']['purpose']): ActivationView {
	return {
		spec: { id: 'activation', seat: 'assistant', attempt: 1, purpose },
		through: purpose.kind === 'summarize' ? purpose.through : 4,
		context: { name: 'room', now: 0, participants: [], messages: [] },
	};
}

function roomThatCommits(commits: CommitRequest[]): SeatRoom {
	return {
		view: async () => ({ stale: 'unused' }),
		commit: async (request): Promise<CommitResult> => {
			commits.push(request);
			return {
				committed: {
					kind: 'summary',
					seq: 5,
					at: '2026-01-01T00:00:00.000Z',
					from: 'assistant',
					to: 'priya',
					text: 'The room stamped this.',
					covers: { from: 2, through: 4 },
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
		const activation = new Activation('activation', assistant.name, host);
		const room = roomThatCommits([]);
		const held = binding(activation, room);

		expect(names(toolsFor(view({ kind: 'respond', message: 4 }), assistant, held))).toEqual([
			'say',
			'record_decision',
		]);
		expect(
			names(
				toolsFor(view({ kind: 'select', exchange: 4, person: 'priya', limit: 2 }), assistant, held),
			),
		).toEqual(['seat']);
		expect(
			names(
				toolsFor(
					view({ kind: 'summarize', exchange: 4, person: 'priya', through: 7 }),
					assistant,
					held,
				),
			),
		).toEqual(['summarise']);
	});

	it('sends summary text only and lets the room stamp recipient and range', async () => {
		const commits: CommitRequest[] = [];
		const activation = new Activation('closed:4:assistant:1', assistant.name, host);
		const tools = toolsFor(
			view({ kind: 'summarize', exchange: 4, person: 'priya', through: 7 }),
			assistant,
			binding(activation, roomThatCommits(commits)),
		);
		const summary = tools[0];
		if (summary === undefined) throw new Error('The summarize purpose has no tool.');
		const result = await summary.execute('summary-call', { text: '  A short result.  ' });

		expect(result.content).toEqual([{ type: 'text', text: 'delivered' }]);
		expect(commits).toEqual([
			{
				activation: 'closed:4:assistant:1',
				key: 'summary-call',
				intent: { kind: 'summary', text: 'A short result.' },
			},
		]);
	});

	it('acknowledges a live response boundary but fixes a summary at its close', () => {
		const at = '2026-01-01T00:00:00.000Z';
		const entries: Entry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					assistant: 'assistant',
					agents: [
						{ name: 'assistant', identity: 'A.', attention: 'none' },
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
				body: { owner: 'priya', from: 3, through: 3, at, wakes: ['assistant'] },
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
			unseen: () => 0,
		};
		const summary = activationSpec('closed:3:assistant:1', state);
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
});
