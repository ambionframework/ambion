import { describe, expect, it } from 'vitest';
import { defineAgent } from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { viewOf } from '../src/room/view.ts';
import { renderActivation } from '../src/seat/render.ts';
import type { ActivationSpec, ContextParticipant } from '../src/transport.ts';
import { assertWire, roundTrip } from '../src/transport.ts';
import type { Message } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);

const entries: Entry[] = [
	{
		kind: 'composition',
		seq: 1,
		body: {
			goal: 'Ship payments v2.',
			assistant: 'assistant',
			agents: [
				{ name: 'assistant', identity: 'Writes decisions.', attention: 'none' },
				{ name: 'product', identity: 'Owns product facts.', attention: 'broadcast' },
			],
			available: [{ name: 'surveyor', identity: 'Checks tonnage.', attention: 'broadcast' }],
			at,
		},
	},
	{
		kind: 'message',
		seq: 2,
		body: {
			kind: 'arrived',
			at,
			from: 'priya',
			subject: 'priya',
			identity: 'Project manager.',
			preferences: 'Lead with blockers.',
		},
	},
	{ kind: 'message', seq: 3, body: { kind: 'said', at, from: 'priya', text: 'Question.' } },
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
		body: {
			kind: 'arrived',
			at,
			from: 'sam',
			subject: 'sam',
			identity: 'Delivery lead.',
			preferences: 'SECRET SAM PREFERENCE.',
		},
	},
];

const facts = () => {
	const state = foldRoom(entries, { backoff: () => 0 });
	return {
		name: 'payments',
		now,
		state,
		live: new Map<string, string[]>(),
		unseen: () => 0,
	};
};

const spec = {
	respond: {
		id: 'message:5:product:1',
		seat: 'product',
		attempt: 1,
		purpose: { kind: 'respond', message: 5 },
	},
	select: {
		id: 'opened:3:assistant:1',
		seat: 'assistant',
		attempt: 1,
		purpose: { kind: 'select', exchange: 3, person: 'priya', limit: 1 },
	},
	summarize: {
		id: 'closed:3:assistant:1',
		seat: 'assistant',
		attempt: 1,
		purpose: { kind: 'summarize', exchange: 3, person: 'priya', through: 3 },
	},
} satisfies Record<string, ActivationSpec>;

const product = defineAgent({
	name: 'product',
	identity: 'Owns product facts.',
	instructions: 'PRIVATE PRODUCT INSTRUCTIONS.',
	model: 'scripted/product',
});

const assistant = defineAgent({
	name: 'assistant',
	identity: 'Writes decisions.',
	instructions: 'PRIVATE ASSISTANT INSTRUCTIONS.',
	model: 'scripted/assistant',
});

describe('structured activation context', () => {
	it('is plain JSON and keeps executable fields out of the room response', () => {
		const views = Object.values(spec).map((activation) => viewOf(activation, facts()));

		for (const view of views) {
			expect(() => assertWire(view)).not.toThrow();
			expect(roundTrip(view)).toStrictEqual(view);
			expect(JSON.stringify(view.context)).not.toContain('PRIVATE');
			expect(view).not.toHaveProperty('model');
			expect(view).not.toHaveProperty('systemPrompt');
			expect(JSON.stringify(view.context)).not.toContain('sessionId');
		}
	});

	it('detaches nested messages and participants from the folded room state', () => {
		const roomFacts = facts();
		const first = viewOf(spec.respond, roomFacts);
		const mutable = first.context as unknown as {
			messages: Message[];
			participants: ContextParticipant[];
		};
		const message = mutable.messages.find((item) => item.kind === 'said' && item.text === 'Later.');
		if (message === undefined || message.kind !== 'said')
			throw new Error('Expected a spoken message.');
		message.text = 'Changed outside the room.';
		if (message.wakes === undefined) throw new Error('Expected wake metadata.');
		message.wakes.push('changed-outside-the-room');
		const person = mutable.participants.find((item) => item.kind === 'human');
		if (person === undefined || person.kind !== 'human') throw new Error('Expected a person.');
		person.identity = 'Changed outside the room.';

		const again = viewOf(spec.respond, roomFacts);
		expect(again.context.messages).toContainEqual(expect.objectContaining({ text: 'Question.' }));
		expect(again.context.messages).toContainEqual(
			expect.objectContaining({ text: 'Later.', wakes: ['product'] }),
		);
		expect(again.context.messages).not.toContainEqual(
			expect.objectContaining({ text: 'Changed outside the room.' }),
		);
		expect(again.context.participants).toContainEqual(
			expect.objectContaining({ name: 'priya', identity: 'Project manager.' }),
		);
	});

	it('scopes reserve and preferences to their authorized assistant purposes', () => {
		const response = viewOf(spec.respond, facts()).context;
		const selection = viewOf(spec.select, facts()).context;
		const summary = viewOf(spec.summarize, facts()).context;

		expect(response).not.toHaveProperty('reserve');
		expect(response).not.toHaveProperty('preferences');
		expect(JSON.stringify(response)).not.toContain('Lead with blockers.');
		expect(JSON.stringify(response)).not.toContain('SECRET SAM PREFERENCE.');
		expect(selection.reserve).toEqual([{ name: 'surveyor', identity: 'Checks tonnage.' }]);
		expect(selection).not.toHaveProperty('preferences');
		expect(JSON.stringify(selection)).not.toContain('Lead with blockers.');
		expect(JSON.stringify(selection)).not.toContain('SECRET SAM PREFERENCE.');
		expect(summary.preferences).toBe('Lead with blockers.');
		expect(JSON.stringify(summary)).not.toContain('SECRET SAM PREFERENCE.');
		expect(summary).not.toHaveProperty('reserve');
		// A later exchange must not enter a fixed summary context.
		expect(summary).not.toHaveProperty('exchange');
	});

	it('keeps summary messages fixed at the recorded close boundary', () => {
		const summary = viewOf(spec.summarize, facts());

		expect(summary.through).toBe(3);
		expect(summary.context.messages.map((message) => message.seq)).toEqual([3]);
		expect(summary.context.messages).not.toContainEqual(
			expect.objectContaining({ text: 'Later.' }),
		);
	});

	it('renders the same selected facts at the executor boundary', () => {
		const response = renderActivation(viewOf(spec.respond, facts()), product);
		const summary = renderActivation(viewOf(spec.summarize, facts()), assistant);

		expect(response.systemPrompt).toContain('PRIVATE PRODUCT INSTRUCTIONS.');
		expect(response.context).toContain('Later.');
		expect(summary.systemPrompt).toContain('Lead with blockers.');
		expect(summary.context).toContain('Question.');
		expect(summary.context).not.toContain('Later.');
	});
});
