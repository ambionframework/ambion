/**
 * What a participant reads of one message, of the omitted record, of the
 * delta a later pass reads, and the URIs a prompt states. The renderers are
 * pure, so every test here hands them a value.
 */
import { describe, expect, it } from 'vitest';
import { renderLine } from '../src/execution/line.ts';
import { renderActivation, renderDelta, renderRecord } from '../src/execution/render.ts';
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

describe('the recall note', () => {
	const worker = scriptedAgent('worker');
	const spec = { id: 'a', seat: 'worker', attempt: 1 };
	const respond = { kind: 'respond', message: 5 } as const;
	const summarize = {
		kind: 'summarize',
		exchange: 5,
		person: 'priya',
		people: ['priya'],
		through: 5,
	} as const;
	const shown: Message[] = [{ kind: 'said', seq: 5, at, from: 'priya', text: 'Newer.' }];
	it.each([
		[
			'a response whose window or cap left out a message',
			respond,
			{ earliest: 5, omitted: 3 },
			true,
		],
		['a response that reads the whole record', respond, {}, false],
		['a summary whose window left out a message', summarize, { earliest: 5, omitted: 3 }, false],
	] as const)('%s', (_case, purpose, reach, noted) => {
		const view: ActivationView = {
			spec: { ...spec, purpose },
			through: 5,
			context: { name: 'site', now: 0, participants: [], messages: shown, reserve: [], ...reach },
		};
		expect(renderActivation(view, worker).context.includes('call recall with its seq')).toBe(noted);
	});
});

describe('one line of the record', () => {
	it('reads a say as its author, and names who it was directed at', () => {
		const said: Message = { kind: 'said', seq: 2, at, from: 'priya', text: 'Is the pour on?' };
		expect(renderLine(said)).toBe('#2 [priya] Is the pour on?');
		expect(renderLine({ ...said, to: 'product' })).toBe('#2 [priya → product] Is the pour on?');
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
		expect(renderLine(said)).toBe('#2 [a → b] Done. (refs: https://x/1 file:///2)');
	});

	it('reads a scheduled say with the time it returns, a returned say with its handle, and a post', () => {
		const later: Message = {
			kind: 'said',
			seq: 3,
			at,
			from: 'worker',
			to: 'worker',
			text: 'Check the build.',
			after: 600,
		};
		const returns = new Date(Date.parse(at) + 600_000).toISOString();
		expect(renderLine(later)).toBe(`#3 [worker → worker] Check the build. (returns at ${returns})`);
		const returned: Message = {
			kind: 'posted',
			seq: 9,
			at,
			to: 'worker',
			returns: 3,
			text: 'Check the build.',
			refs: ['file:///out.log'],
		};
		expect(renderLine(returned)).toBe(
			'#9 [posted → worker, returns #3] Check the build. (refs: file:///out.log)',
		);
		const posted: Message = { kind: 'posted', seq: 10, at, text: 'ci: build 412 failed.' };
		expect(renderLine(posted)).toBe('#10 [posted → the room] ci: build 412 failed.');
	});

	it.each([
		['the seat', { from: 'worker' }, '#9 · worker dismissed say #3'],
		['the host', {}, '#9 · the host dismissed say #3'],
	])('reads a dismissal by %s with the handle it dismissed', (_by, from, line) => {
		expect(renderLine({ kind: 'dismissed', seq: 9, at, message: 3, ...from })).toBe(line);
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
		expect(renderLine(summary)).toBe('#6 [writer → priya] Saturday.');
	});

	it('names a presence author only where it differs from the subject', () => {
		// A person arrives by themselves, so the two names are one and the
		// line says it once: "priya arrived by priya" tells a reader nothing.
		const arrived: Message = { kind: 'arrived', seq: 1, at, from: 'priya', subject: 'priya' };
		expect(renderLine(arrived)).toBe('#1 · priya arrived');
		expect(renderLine({ ...arrived, kind: 'left' })).toBe('#1 · priya left');

		// An ordinary seat seated the surveyor, so the line names both.
		const seated: Message = {
			kind: 'seated',
			seq: 8,
			at,
			from: 'product',
			subject: 'surveyor',
			identity: 'Holds the tonnage.',
		};
		expect(renderLine(seated)).toBe('#8 · surveyor seated by product');

		// The host seated it, and the host is not a participant: no author.
		const byHost: Message = { kind: 'seated', seq: 8, at, subject: 'surveyor' };
		expect(renderLine(byHost)).toBe('#8 · surveyor seated');
		expect(renderLine({ ...byHost, kind: 'unseated' })).toBe('#8 · surveyor unseated');
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
				exchange: { person: 'priya', from: 4 },
			},
		};
		const rendered = renderActivation(view, worker);
		expect(rendered.context).toContain(roomUri('site'));
		expect(rendered.agent).toContain('refs');
		expect(rendered.context).toContain('opened by message 4');
		expect(rendered.context).toContain(messageUri('site', 4));
		expect(rendered.context).not.toContain('/exchange/');
		expect(rendered.context).not.toContain('a say you scheduled');
		// An exchange that names no person, with its opening out of the view, names only its start.
		const bare = renderActivation(
			{ ...view, context: { ...view.context, exchange: { from: 4 } } },
			worker,
		).context;
		expect(bare).toContain('Exchange 4 is active.');
		expect(bare).not.toContain('human direction');
		// The kernel names no database: a seat with no database reads no database guidance.
		expect(`${rendered.mechanism}${rendered.agent}`).not.toMatch(/database|sqlite/i);
	});

	it('states that a returned say that opened the exchange is the seat’s own', () => {
		const returned: Message = {
			kind: 'posted',
			seq: 4,
			at,
			to: 'worker',
			returns: 2,
			text: 'Check the build.',
		};
		const view: ActivationView = {
			spec: { ...spec, purpose: { kind: 'respond', message: 4 } },
			through: 4,
			context: { ...context, messages: [returned], exchange: { from: 4 } },
		};
		const later = { seq: 6, seat: 'worker', due: at, text: 'Check again.' };
		const rendered = renderActivation(
			{ ...view, context: { ...view.context, scheduled: [later] } },
			worker,
		).context;
		expect(rendered).toContain(
			'Exchange 4 is active: message 4 is a say you scheduled, and the room returned it.',
		);
		expect(rendered).not.toContain('human direction');
		// Another seat in the exchange reads whose say it is.
		expect(renderActivation(view, scriptedAgent('reviewer')).context).toContain(
			'message 4 is a say worker scheduled',
		);
		expect(rendered).toContain(
			`Your scheduled messages. The room wakes you with each one at its due time. Call \`dismiss\` with the seq of one that no longer fits:\n- #6, due ${at}: Check again.`,
		);
		expect(renderActivation(view, worker).context).not.toContain('Your scheduled messages');
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
			'[new] #2 [worker → priya] Newer. (refs: file:///a)\n[new] #3 · sam arrived',
		);
		expect(renderDelta(view, 3)).toBeUndefined();
	});
});
