/**
 * The rendered prompt of one ordinary and one closing activation, part by
 * part. The snapshots put the prompt text in the diff of every change to it.
 * The speaking policy of a definition replaces the default in the agent part.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { DEFAULT_GUIDANCE, renderActivation } from '../src/execution/render.ts';
import type { ActivationView } from '../src/hosting.ts';
import { defineAgent } from '../src/index.ts';
import type { Message } from '../src/types.ts';

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
			kind: 'human' as const,
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
};
const worker = defineAgent({
	name: 'worker',
	identity: 'Works.',
	executor: pi({ instructions: 'Work carefully.', model: 'scripted/worker' }),
});
const respond: ActivationView = {
	spec: { id: 'a', seat: 'worker', attempt: 1, purpose: { kind: 'respond', message: 2 } },
	through: 3,
	context: { ...context, exchange: { owner: 'priya', from: 2 } },
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
	it('renders an ordinary activation', () => {
		const { mechanism, agent, context: read } = renderActivation(respond, worker);
		expect(mechanism).toMatchSnapshot('mechanism');
		expect(agent).toMatchSnapshot('agent');
		expect(read).toMatchSnapshot('context');
	});

	it('renders a closing activation', () => {
		const { agent, context: read } = renderActivation(summarize, worker);
		expect(agent).toMatchSnapshot('agent');
		expect(read).toMatchSnapshot('context');
	});

	it('keeps the mechanism the same for every purpose and definition, and renders the speaking policy', () => {
		const other = defineAgent({
			name: 'other',
			identity: 'Other.',
			executor: pi({ instructions: 'Other.', model: 'scripted/other', speaking: 'Be brief.' }),
		});
		const { mechanism } = renderActivation(respond, worker);
		expect(renderActivation(summarize, worker).mechanism).toBe(mechanism);
		expect(renderActivation(respond, other).mechanism).toBe(mechanism);
		for (const text of ['worker', 'site', 'Is the pour on?', 'Work carefully.'])
			expect(mechanism).not.toContain(text);
		expect(renderActivation(respond, worker).agent).toContain(DEFAULT_GUIDANCE);
		const policy = renderActivation(respond, other).agent;
		expect(policy).toContain('Be brief.');
		expect(policy).not.toContain(DEFAULT_GUIDANCE);
	});
});
