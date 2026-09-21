import type { ExchangeView, Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { type Block, buildTimeline, discussionKeys } from '../src/timeline.ts';

const said = (seq: number, from: string, to?: string): Message =>
	({ seq, kind: 'said', from, to, text: `${from} ${seq}`, at: '2026-01-01T00:00:00Z' }) as Message;
type Summary = Extract<Message, { kind: 'summary' }>;
const AT = '2026-01-01T00:00:00Z';
const summaryOf = (seq: number, to: string): Summary =>
	({
		seq,
		kind: 'summary',
		from: 'assistant',
		to,
		text: `summary ${seq}`,
		at: '2026-01-01T00:00:00Z',
	}) as Summary;
const arrived = (seq: number): Message =>
	({ seq, kind: 'arrived', subject: 'theo', at: '2026-01-01T00:00:00Z' }) as Message;

const humans = new Set(['theo', 'mira']);
const build = (
	messages: Message[],
	exchanges: ExchangeView[],
	extra: Partial<Parameters<typeof buildTimeline>[0]> = {},
) =>
	buildTimeline({
		messages,
		exchanges,
		humans,
		working: [],
		expanded: new Set(),
		...extra,
	});

const shape = (blocks: Block[]) =>
	blocks.map((block) => {
		if (block.type === 'message') return `${block.role}:${block.message.seq}`;
		if (block.type === 'discussion') return `discussion:${block.key}(${block.count})`;
		return block.type;
	});

// The introspect room's exchange: a person answers an agent inside the exchange.
const thread = [
	said(98, 'theo'),
	said(102, 'assistant', 'datasheets'),
	said(121, 'assistant', 'theo'),
	said(125, 'theo'),
	said(128, 'assistant', 'experiments'),
	said(134, 'experiments'),
	summaryOf(145, 'theo'),
];
const closed: ExchangeView = {
	from: 98,
	through: 134,
	status: 'closed',
	activations: [],
	outcome: { kind: 'complete' },
	owner: 'theo',
	at: AT,
	summary: { status: 'published', summary: summaryOf(145, 'theo') },
};

describe('buildTimeline', () => {
	it('keeps a steering message inside the discussion, and the summary last', () => {
		const blocks = build(thread, [closed]);
		expect(shape(blocks)).toEqual(['question:98', 'discussion:98(5)', 'summary:145']);
		const discussion = blocks[1];
		if (discussion?.type !== 'discussion') throw new Error('Expected a discussion.');
		expect(discussion.items.map((item) => [item.message.seq, item.role])).toEqual([
			[102, 'said'],
			[121, 'said'],
			[125, 'steer'],
			[128, 'said'],
			[134, 'said'],
		]);
		expect(discussion.voices).toEqual(['assistant', 'theo', 'experiments']);
		expect(discussion.flag).toBe('');
	});

	it('marks a discussion open only when its key is in the expanded set', () => {
		const closedThread = build(thread, [closed]);
		expect(discussionKeys(closedThread)).toEqual(['98']);
		const before = closedThread[1];
		const after = build(thread, [closed], { expanded: new Set(['98']) })[1];
		expect(before?.type === 'discussion' && before.expanded).toBe(false);
		expect(after?.type === 'discussion' && after.expanded).toBe(true);
	});

	it('shows one reply directly, with no discussion and no summary', () => {
		const messages = [said(59, 'mira'), said(61, 'assistant', 'mira'), summaryOf(66, 'mira')];
		const exchange: ExchangeView = {
			from: 59,
			through: 61,
			status: 'closed',
			activations: [],
			outcome: { kind: 'complete' },
			owner: 'mira',
			at: AT,
			summary: { status: 'published', summary: summaryOf(66, 'mira') },
		};
		expect(shape(build(messages, [exchange]))).toEqual(['question:59', 'said:61']);
	});

	it('keeps the closing mark when a person is the only one who spoke after the question', () => {
		// An exchange aborted after a follow-up: no agent replied, so there is nothing to show directly.
		const exchange: ExchangeView = {
			from: 4,
			through: 9,
			status: 'closed',
			activations: [],
			outcome: { kind: 'complete' },
			owner: 'mira',
			at: AT,
			summary: { status: 'silent' },
		};
		const blocks = build([said(4, 'mira'), said(9, 'mira')], [exchange]);
		expect(shape(blocks)).toEqual(['question:4', 'discussion:4(1)']);
		expect(blocks[1]).toMatchObject({ flag: 'No summary' });
	});

	it('notes a closed exchange that has no reply and no summary', () => {
		const exchange: ExchangeView = {
			from: 75,
			through: 75,
			status: 'closed',
			activations: [],
			outcome: { kind: 'complete' },
			owner: 'theo',
			at: AT,
			summary: { status: 'silent' },
		};
		const blocks = build([said(75, 'theo')], [exchange]);
		expect(shape(blocks)).toEqual(['question:75', 'note']);
		expect(blocks[1]).toMatchObject({ text: 'Closed without a summary' });
	});

	it('flags a discussion whose summary is pending or failed', () => {
		const pending: ExchangeView = { ...closed, summary: { status: 'pending' } };
		const blocks = build(thread.slice(0, -1), [pending]);
		expect(blocks[1]).toMatchObject({ type: 'discussion', flag: 'Summary pending' });
	});

	it('keeps the open exchange in the open, and ends with a live block', () => {
		const messages = [said(4, 'mira'), said(6, 'assistant', 'design'), said(9, 'mira')];
		const open: ExchangeView = { from: 4, status: 'open', owner: 'mira', at: AT, activations: [] };
		const blocks = build(messages, [open], {
			open: { owner: 'mira' },
			working: ['assistant', 'design'],
		});
		expect(shape(blocks)).toEqual(['question:4', 'said:6', 'question:9', 'live']);
		expect(blocks.at(-1)).toMatchObject({
			text: 'Working on mira’s question with assistant, design',
		});
	});

	it('ignores presence entries', () => {
		expect(shape(build([arrived(1), said(2, 'mira'), arrived(3)], []))).toEqual(['question:2']);
	});

	it('shows an earlier exchange collapsed beside a newer open one', () => {
		const later: ExchangeView = {
			from: 150,
			status: 'open',
			owner: 'mira',
			at: AT,
			activations: [],
		};
		const blocks = build([...thread, said(150, 'mira')], [closed, later], {
			open: { owner: 'mira' },
		});
		expect(shape(blocks)).toEqual([
			'question:98',
			'discussion:98(5)',
			'summary:145',
			'question:150',
			'live',
		]);
	});
});

describe('cost and awaiting', () => {
	const usage = { input: 9000, output: 3300, cacheRead: 0, cacheWrite: 0 };
	const exchangeWith = (extra: Record<string, unknown>): ExchangeView =>
		({ ...closed, ...extra }) as ExchangeView;

	it('shows the cost of an exchange on its discussion', () => {
		const blocks = build(thread, [exchangeWith({ usage: { ...usage, cost: 0.0123 } })]);
		expect(blocks[1]).toMatchObject({ type: 'discussion', cost: '$0.0123', activations: 0 });
	});

	it('falls back to tokens when the usage has no cost, and to nothing without usage', () => {
		expect(build(thread, [exchangeWith({ usage })])[1]).toMatchObject({ cost: '12.3k tokens' });
		expect(build(thread, [closed])[1]).toMatchObject({ cost: '' });
	});

	it('reads an awaiting exchange as waiting on the person, and not as a plain close', () => {
		const awaiting = exchangeWith({
			outcome: { kind: 'awaiting', person: 'theo' },
			summary: { status: 'silent' },
		});
		expect(build(thread.slice(0, 6), [awaiting])[1]).toMatchObject({ flag: 'Waiting on theo' });
	});

	it('puts the waiting and the cost in the note of an exchange with no messages', () => {
		const awaiting = exchangeWith({
			outcome: { kind: 'awaiting', person: 'theo' },
			summary: { status: 'silent' },
			usage: { ...usage, cost: 0.5 },
		});
		const blocks = build([said(98, 'theo')], [awaiting]);
		expect(blocks.at(-1)).toEqual({ type: 'note', text: 'Waiting on theo · $0.5000' });
	});

	it('places the tail blocks after the closed exchanges and before the live block', () => {
		const later: ExchangeView = {
			from: 150,
			status: 'open',
			owner: 'mira',
			at: AT,
			activations: [],
		};
		const blocks = build([...thread, said(150, 'mira')], [closed, later], {
			open: { owner: 'mira' },
			tail: [{ type: 'note', text: 'Waiting.' }],
		});
		expect(shape(blocks).slice(-2)).toEqual(['note', 'live']);
	});
});
