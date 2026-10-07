/**
 * The rendered prompt of one respond and one summary activation, part by
 * part. The snapshots put the prompt text in the diff of every change to it.
 * The speaking and summarizing policies of a definition replace the defaults
 * in the agent part and in the ask line.
 * The resolved reminders of the definition's bundles join the context of a
 * respond activation, before its ask line.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import type { ReminderSeat } from '../src/bundle.ts';
import { REMINDER_TIMEOUT_MS, resolveReminders } from '../src/execution/reminders.ts';
import {
	DEFAULT_SPEAKING,
	DEFAULT_SUMMARIZING,
	renderActivation,
} from '../src/execution/render.ts';
import type { ActivationView } from '../src/hosting.ts';
import { defineAgent } from '../src/index.ts';
import type { Message } from '../src/types.ts';
import { functionRuntime } from './support/compose-runtime.ts';

const at = '2026-01-01T09:00:00.000Z';
const messages: Message[] = [
	{ kind: 'arrived', seq: 1, at, subject: 'priya' },
	{ kind: 'said', seq: 2, at, from: 'priya', text: 'Is the pour on?' },
	{ kind: 'said', seq: 3, at, from: 'worker', to: 'priya', text: 'Yes, at nine.' },
];
const context = {
	name: 'site',
	now: Date.parse(at) + 5 * 60_000,
	participants: [
		{
			kind: 'person' as const,
			name: 'priya',
			identity: 'Project manager.',
			presence: 'present' as const,
			messagesSinceDeparture: 0,
		},
		{
			kind: 'agent' as const,
			name: 'worker',
			identity: 'Works.',
			status: 'active' as const,
			attention: 'broadcast' as const,
		},
	],
	messages,
	reserve: [{ name: 'surveyor', identity: 'Checks tonnage.' }],
	reserved: true as const,
};
const worker = defineAgent({
	name: 'worker',
	identity: 'Works.',
	executor: pi({
		instructions: 'Work carefully.',
		model: 'scripted/worker',
		// A short guidance keeps this snapshot apart from the text of COMPOSE_GUIDANCE.
		compose: { runtime: functionRuntime, guidance: 'Compose when one result feeds another.' },
	}),
});
const respond: ActivationView = {
	spec: { id: 'a', seat: 'worker', attempt: 1, purpose: { kind: 'respond', message: 2 } },
	through: 3,
	context: {
		...context,
		exchange: { person: 'priya', from: 2 },
		scheduled: [
			{
				seq: 4,
				seat: 'worker',
				due: '2026-01-01T10:00:00.000Z',
				text: 'Check the pour log.',
				refs: ['file:///pours.log'],
			},
		],
	},
};
const summarize: ActivationView = {
	spec: {
		id: 'b',
		seat: 'worker',
		attempt: 1,
		purpose: { kind: 'summarize', exchange: 2, person: 'priya', people: ['priya'], through: 3 },
	},
	through: 3,
	context,
};

describe('the rendered prompt', () => {
	it('renders a respond activation', () => {
		const { mechanism, agent, context: read } = renderActivation(respond, worker);
		expect(mechanism).toMatchSnapshot('mechanism');
		expect(agent).toMatchSnapshot('agent');
		expect(read).toMatchSnapshot('context');
	});

	it('renders the same hand-off whether or not the room offers seat', () => {
		const handoff = (extra: object) =>
			renderActivation({ ...respond, context: { ...respond.context, ...extra } }, worker).agent;
		expect(handoff({ seating: false })).toBe(handoff({}));
		expect(handoff({ reserved: undefined })).toBe(handoff({}));
		expect(handoff({})).toContain('colleague with no mark reads the record');
	});

	it('renders a closing activation', () => {
		const { agent, context: read } = renderActivation(summarize, worker);
		expect(agent).toMatchSnapshot('agent');
		expect(read).toMatchSnapshot('context');
	});

	it('keeps the mechanism the same for every purpose and definition, and lets the definition replace each policy', () => {
		const other = defineAgent({
			name: 'other',
			identity: 'Other.',
			executor: pi({
				instructions: 'Other.',
				model: 'scripted/other',
				speaking: 'Custom policy.',
				summarizing: 'Custom summary policy.',
			}),
		});
		const { mechanism } = renderActivation(respond, worker);
		expect(renderActivation(summarize, worker).mechanism).toBe(mechanism);
		expect(renderActivation(respond, other).mechanism).toBe(mechanism);
		expect(renderActivation(summarize, other).mechanism).toBe(mechanism);
		for (const text of ['worker', 'site', 'Is the pour on?', 'Work carefully.'])
			expect(mechanism).not.toContain(text);

		const standard = renderActivation(respond, worker);
		expect(standard.agent).toContain(DEFAULT_SPEAKING);
		const policy = renderActivation(respond, other);
		expect(policy.agent).toContain('Custom policy.');
		for (const advice of [
			DEFAULT_SPEAKING,
			'Who is reading can change while you work',
			'The record holds conversation',
		])
			expect(policy.agent).not.toContain(advice);
		expect(policy.context.split('\n').at(-1)).toBe(
			"priya's exchange opened by message 2 is active; the marked request is the current human direction. The opening message's URI is ambion://room/site/message/2. Begin your activation, other: this is a respond activation.",
		);
		for (const advice of [
			'Follow your instructions',
			'already answered',
			'An explicit later request',
			'These speech defaults',
		])
			expect(policy.context).not.toContain(advice);

		const closing = renderActivation(summarize, worker);
		expect(closing.agent).toContain(DEFAULT_SUMMARIZING);
		expect(closing.context).toContain('Check two cases first');
		const custom = renderActivation(summarize, other);
		expect(custom.agent).toContain('Custom summary policy.');
		expect(custom.agent).not.toContain('The exchange is over. Write the one message');
		expect(custom.agent).toContain('You are writing for priya.');
		expect(custom.context.split('\n').at(-1)).toBe(
			"priya's exchange is over: it holds the messages from seq 2 to seq 3. The opening message's URI is ambion://room/site/message/2. Write the message with say, or end your activation without calling say to leave the range whole.",
		);
		expect(custom.context).not.toContain('Check two cases first');
	});

	it('resolves the bundle reminders of a respond activation, drops a throw, a rejection, blank text, and a late one, and places them before the ask line', async () => {
		const seats: ReminderSeat[] = [];
		const reminded = defineAgent({
			name: 'worker',
			identity: 'Works.',
			executor: pi({
				instructions: 'Work carefully.',
				model: 'scripted/worker',
				bundles: [
					{
						tools: [],
						remind: async (seat) => {
							seats.push(seat);
							return 'Your process p1 runs.';
						},
					},
					{
						tools: [],
						remind: () => {
							throw new Error('The reminder broke.');
						},
					},
					{ tools: [], remind: async () => Promise.reject(new Error('The read failed.')) },
					{ tools: [], remind: () => '  ' },
					{ tools: [], remind: () => new Promise<string>(() => undefined) },
					{ tools: [] },
				],
			}),
		});
		vi.useFakeTimers();
		onTestFinished(() => void vi.useRealTimers());
		const pending = resolveReminders(respond, reminded);
		await vi.advanceTimersByTimeAsync(REMINDER_TIMEOUT_MS);
		const text = await pending;
		expect(text).toBe('Your process p1 runs.');
		expect(seats).toEqual([{ agent: 'worker', room: 'site', activation: 'a' }]);
		const plain = renderActivation(respond, worker).context.split('\n');
		const lines = renderActivation(respond, reminded, text).context.split('\n');
		expect(lines).toEqual([...plain.slice(0, -1), 'Your process p1 runs.', '', plain.at(-1)]);
		expect(await resolveReminders(summarize, reminded)).toBeUndefined();
		expect(renderActivation(summarize, worker, text).context).toBe(
			renderActivation(summarize, worker).context,
		);
		expect(seats).toHaveLength(1);
	});
});
