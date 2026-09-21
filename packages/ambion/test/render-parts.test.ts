/**
 * The speaking policy slot of the agent part, and the delta a later pass reads.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { DEFAULT_GUIDANCE, renderActivation, renderDelta } from '../src/execution/render.ts';
import type { ActivationView } from '../src/hosting.ts';
import { defineAgent } from '../src/index.ts';
import type { Message } from '../src/types.ts';

describe('the speaking policy', () => {
	const view: ActivationView = {
		spec: { id: 'a', seat: 'worker', attempt: 1, purpose: { kind: 'respond', message: 1 } },
		through: 1,
		context: { name: 'site', now: 0, participants: [], messages: [], reserve: [] },
	};
	const define = (speaking?: string) =>
		defineAgent({
			name: 'worker',
			identity: 'Works.',
			executor: pi({
				instructions: 'Work.',
				model: 'scripted/worker',
				...(speaking === undefined ? {} : { speaking }),
			}),
		});

	it('renders the default when a definition supplies none', () => {
		expect(renderActivation(view, define()).agent).toContain(DEFAULT_GUIDANCE);
	});

	it('renders the policy of a definition in place of the default', () => {
		const { agent } = renderActivation(view, define('Speak in haiku.'));
		expect(agent).toContain('Speak in haiku.');
		expect(agent).not.toContain(DEFAULT_GUIDANCE);
	});
});

describe('renderDelta', () => {
	const at = '2026-01-01T09:00:00.000Z';
	const messages: Message[] = [
		{ kind: 'said', seq: 1, at, from: 'priya', text: 'Old.' },
		{ kind: 'said', seq: 2, at, from: 'worker', to: 'priya', text: 'Newer.', refs: ['file:///a'] },
		{ kind: 'arrived', seq: 3, at, subject: 'sam' },
	];
	const view: ActivationView = {
		spec: { id: 'a', seat: 'worker', attempt: 1, purpose: { kind: 'respond', message: 1 } },
		through: 3,
		context: { name: 'site', now: 0, participants: [], messages, reserve: [] },
	};

	it('prefixes each later message with [new], in order', () => {
		expect(renderDelta(view, 1)).toBe(
			'[new] [worker → priya] Newer. (refs: file:///a)\n[new] · sam arrived',
		);
	});

	it('returns nothing when no message stands beyond the position', () => {
		expect(renderDelta(view, 3)).toBeUndefined();
	});
});
