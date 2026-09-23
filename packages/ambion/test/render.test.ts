/**
 * What a participant reads of one message, of the omitted record, of the
 * delta a later pass reads, and the URIs a prompt states. The renderers are
 * pure, so every test here hands them a value.
 */
import { describe, expect, it } from 'vitest';
import {
	renderActivation,
	renderDelta,
	renderLine,
	renderRecord,
} from '../src/execution/render.ts';
import type { ActivationView } from '../src/hosting.ts';
import { messageUri, roomUri } from '../src/index.ts';
import type { Message } from '../src/types.ts';
import { scriptedAgent } from './support/room.ts';

const at = '2026-01-01T09:00:00.000Z';

describe('the omission line', () => {
	const record: Message[] = [
		{ kind: 'said', seq: 5, at, from: 'priya', text: 'Newer.' },
		{ kind: 'said', seq: 6, at, from: 'worker', text: 'Reply.' },
	];
	const now = Date.parse(at);

	it('leads the record with a count of the earlier messages, before the exchange divider', () => {
		expect(renderRecord(record, [], now, 6, 3).split('\n')[0]).toBe(
			'── 3 earlier messages not shown ──',
		);
		expect(renderRecord(record, [], now, undefined, 1).split('\n')[0]).toBe(
			'── 1 earlier message not shown ──',
		);
		const lines = renderRecord(record, [], now, 5, 2).split('\n');
		expect(lines[0]).toContain('2 earlier messages');
		expect(lines[1]).toContain('Current exchange begins here');
	});

	it('shows no line for zero or an unset count', () => {
		expect(renderRecord(record, [], now, undefined, 0)).not.toContain('not shown');
		expect(renderRecord(record, [], now)).not.toContain('not shown');
	});
});

describe('one line of the record', () => {
	it('reads a say as its author, and names who it was directed at', () => {
		const said: Message = { kind: 'said', seq: 2, at, from: 'priya', text: 'Is the pour on?' };
		expect(renderLine(said)).toBe('[priya] Is the pour on?');
		expect(renderLine({ ...said, to: 'product' })).toBe('[priya → product] Is the pour on?');
	});

	it('appends the refs a message cites', () => {
		const said: Message = {
			kind: 'said',
			seq: 2,
			at,
			from: 'a',
			to: 'b',
			text: 'Done.',
			refs: ['https://x/1', 'file:///2'],
		};
		expect(renderLine(said)).toBe('[a → b] Done. (refs: https://x/1 file:///2)');
	});

	it('reads a summary the way it reads anything addressed to one person', () => {
		const summary: Message = {
			kind: 'summary',
			seq: 6,
			at,
			from: 'writer',
			to: 'priya',
			text: 'Saturday.',
			covers: { from: 2, through: 4 },
		};
		expect(renderLine(summary)).toBe('[writer → priya] Saturday.');
	});

	it('names a presence author only where it differs from the subject', () => {
		// A person arrives by themselves, so the two names are one and the
		// line says it once: "priya arrived by priya" tells a reader nothing.
		const arrived: Message = { kind: 'arrived', seq: 1, at, from: 'priya', subject: 'priya' };
		expect(renderLine(arrived)).toBe('· priya arrived');
		expect(renderLine({ ...arrived, kind: 'left' })).toBe('· priya left');

		// An ordinary seat seated the surveyor, so the line names both.
		const seated: Message = {
			kind: 'seated',
			seq: 8,
			at,
			from: 'product',
			subject: 'surveyor',
			identity: 'Holds the tonnage.',
		};
		expect(renderLine(seated)).toBe('· surveyor seated by product');

		// The host seated it, and the host is not a participant: no author.
		const byHost: Message = { kind: 'seated', seq: 8, at, subject: 'surveyor' };
		expect(renderLine(byHost)).toBe('· surveyor seated');
		expect(renderLine({ ...byHost, kind: 'unseated' })).toBe('· surveyor unseated');
	});
});

describe('the URIs a prompt states', () => {
	const worker = scriptedAgent('worker');
	const spec = { id: 'a', seat: 'worker', attempt: 1 };
	const context = { name: 'site', now: 0, participants: [], messages: [], reserve: [] };

	it('states the room and the open exchange for a response', () => {
		const view: ActivationView = {
			spec: { ...spec, purpose: { kind: 'respond', message: 4 } },
			through: 4,
			context: {
				...context,
				exchange: { owner: 'priya', from: 4 },
			},
		};
		const rendered = renderActivation(view, worker);
		expect(rendered.context).toContain(roomUri('site'));
		expect(rendered.agent).toContain('refs');
		expect(rendered.context).toContain('opened by message 4');
		expect(rendered.context).toContain(messageUri('site', 4));
		expect(rendered.context).not.toContain('/exchange/');
	});

	it('states the covered exchange for a summary', () => {
		const view: ActivationView = {
			spec: {
				...spec,
				purpose: { kind: 'summarize', exchange: 4, person: 'priya', people: ['priya'], through: 7 },
			},
			through: 7,
			context,
		};
		const rendered = renderActivation(view, worker);
		expect(`${rendered.mechanism}${rendered.agent}${rendered.context}`).toContain(
			messageUri('site', 4),
		);
	});
});

describe('renderDelta', () => {
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

	it('prefixes each later message with [new], in order, and returns nothing past the end', () => {
		expect(renderDelta(view, 1)).toBe(
			'[new] [worker → priya] Newer. (refs: file:///a)\n[new] · sam arrived',
		);
		expect(renderDelta(view, 3)).toBeUndefined();
	});
});
