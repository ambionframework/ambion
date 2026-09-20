import { describe, expect, it } from 'vitest';
import { renderActivation } from '../src/execution/render.ts';
import { defineAgent } from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { viewOf } from '../src/room/view.ts';
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
			version: 2,
			goal: 'Ship payments v2.',
			summary: 'worker',
			agents: [
				{ name: 'worker', identity: 'Writes decisions.', attention: 'broadcast' },
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
	return { name: 'payments', now, state, live: new Map<string, string[]>(), unseen: () => 0 };
};

const spec = {
	respond: {
		id: 'message:5:product:1',
		seat: 'product',
		attempt: 1,
		purpose: { kind: 'respond', message: 5 },
	},
	summarize: {
		id: 'closed:3:worker:1',
		seat: 'worker',
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

const worker = defineAgent({
	name: 'worker',
	identity: 'Writes decisions.',
	instructions: 'PRIVATE WORKER INSTRUCTIONS.',
	model: 'scripted/worker',
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

	it('detaches nested messages, participants, and reserve from room state', () => {
		const roomFacts = facts();
		const first = viewOf(spec.respond, roomFacts);
		const mutable = first.context as unknown as {
			messages: Message[];
			participants: ContextParticipant[];
			reserve: { name: string; identity: string }[];
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
		const reserve = mutable.reserve[0];
		if (reserve === undefined) throw new Error('Expected a reserve agent.');
		reserve.identity = 'Changed outside the room.';

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
		expect(again.context.reserve).toEqual([{ name: 'surveyor', identity: 'Checks tonnage.' }]);
	});

	it('shares reserve identities with responses and scopes preferences to the summary writer', () => {
		const response = viewOf(spec.respond, facts()).context;
		const summary = viewOf(spec.summarize, facts()).context;

		expect(response.reserve).toEqual([{ name: 'surveyor', identity: 'Checks tonnage.' }]);
		expect(JSON.stringify(response)).not.toContain('Lead with blockers.');
		expect(JSON.stringify(response)).not.toContain('SECRET SAM PREFERENCE.');
		expect(summary.reserve).toEqual([{ name: 'surveyor', identity: 'Checks tonnage.' }]);
		expect(summary.preferences).toBe('Lead with blockers.');
		expect(JSON.stringify(summary)).not.toContain('SECRET SAM PREFERENCE.');
	});

	it('reads every message through the close boundary, but covers only its own exchange', () => {
		const summary = viewOf(spec.summarize, facts());

		expect(summary.through).toBe(3);
		// The arrival at seq 2 is background: earlier than the exchange this
		// activation covers, but still part of what a closing seat reads.
		expect(summary.context.messages.map((message) => message.seq)).toEqual([2, 3]);
		expect(summary.context.messages).not.toContainEqual(
			expect.objectContaining({ text: 'Later.' }),
		);
	});

	it('renders ordinary and closing prompts with the same ordinary identity', () => {
		const response = renderActivation(viewOf(spec.respond, facts()), product);
		const summary = renderActivation(viewOf(spec.summarize, facts()), worker);

		expect(response.systemPrompt).toContain('PRIVATE PRODUCT INSTRUCTIONS.');
		expect(response.context).toContain('Later.');
		expect(response.context).toContain('The reserve: agents not in the room.');
		expect(response.context).toContain('Take your turn, product:');
		expect(summary.systemPrompt).toContain('PRIVATE WORKER INSTRUCTIONS.');
		expect(summary.systemPrompt).not.toContain('assistant in the room');
		expect(summary.systemPrompt).toContain('The exchange is over. Write the one message');
		expect(summary.systemPrompt).toContain('Lead with blockers.');
		expect(summary.context).not.toContain('The reserve:');
		expect(summary.context).toContain("priya's exchange is over: messages");
		expect(summary.context).not.toContain('Later.');
		// The closing seat reads the arrival that came before its own exchange,
		// with a divider marking where its own exchange begins.
		expect(summary.context).toContain('· priya arrived');
		expect(summary.context).toContain(
			'── Current exchange begins here; earlier exchanges are background ──',
		);
	});

	it('tells a closing seat how to read a fold its background now holds', () => {
		const twoExchanges: Entry[] = [
			{
				kind: 'composition',
				seq: 1,
				body: {
					version: 2,
					summary: 'worker',
					agents: [{ name: 'worker', identity: 'Writes decisions.', attention: 'broadcast' }],
					available: [],
					at,
				},
			},
			{ kind: 'message', seq: 2, body: { kind: 'arrived', at, from: 'sam', subject: 'sam' } },
			{ kind: 'message', seq: 3, body: { kind: 'said', at, from: 'sam', text: "Sam's question." } },
			{ kind: 'close', seq: 4, body: { owner: 'sam', from: 3, through: 3, at, summary: 'worker' } },
			{
				kind: 'message',
				seq: 5,
				body: {
					kind: 'summary',
					at,
					from: 'worker',
					to: 'sam',
					text: 'Answered.',
					covers: { from: 3, through: 3 },
				},
			},
			{ kind: 'message', seq: 6, body: { kind: 'arrived', at, from: 'priya', subject: 'priya' } },
			{
				kind: 'message',
				seq: 7,
				body: { kind: 'said', at, from: 'priya', text: "Priya's question." },
			},
			{
				kind: 'close',
				seq: 8,
				body: { owner: 'priya', from: 7, through: 7, at, summary: 'worker' },
			},
		];
		const state = foldRoom(twoExchanges, { backoff: () => 0 });
		const priyaClose: ActivationSpec = {
			id: 'closed:7:worker:1',
			seat: 'worker',
			attempt: 1,
			purpose: { kind: 'summarize', exchange: 7, person: 'priya', through: 7 },
		};
		const view = viewOf(priyaClose, {
			name: 'payments',
			now,
			state,
			live: new Map(),
			unseen: () => 0,
		});

		// Sam's already-summarised exchange is background priya's writer now
		// reads, folded the same way it would be for an ordinary activation —
		// so the writer needs the same instruction for reading one.
		expect(view.context.messages.some((message) => message.kind === 'summary')).toBe(true);
		const rendered = renderActivation(view, worker);
		expect(rendered.context).toContain('summarised for sam below');
		expect(rendered.systemPrompt).toContain('summarised for <name> below');
	});
});
