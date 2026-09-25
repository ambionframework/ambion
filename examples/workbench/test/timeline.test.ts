import type { ExchangeView, Message } from '@ambionframework/ambion';
import { describe, expect, it } from 'vitest';
import { type Block, buildTimeline, discussionKeys } from '../src/timeline.ts';

const AT = '2026-01-01T00:00:00Z';
const said = (seq: number, from: string, to?: string): Message =>
	({ seq, kind: 'said', from, to, text: `${from} ${seq}`, at: AT }) as Message;
type Summary = Extract<Message, { kind: 'summary' }>;
const summaryOf = (seq: number, to: string): Summary =>
	({ seq, kind: 'summary', from: 'assistant', to, text: `summary ${seq}`, at: AT }) as Summary;
const arrived = (seq: number): Message =>
	({ seq, kind: 'arrived', subject: 'theo', at: AT }) as Message;
const closedExchange = (
	from: number,
	through: number,
	owner: string,
	summary: object = { status: 'silent' },
): ExchangeView =>
	({
		from,
		through,
		status: 'closed',
		activations: [],
		outcome: { kind: 'complete' },
		owner,
		at: AT,
		summary,
	}) as ExchangeView;
const openExchange = (from: number): ExchangeView => ({
	from,
	status: 'open',
	owner: 'mira',
	at: AT,
	activations: [],
});

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
const closed = closedExchange(98, 134, 'theo', {
	status: 'published',
	summary: summaryOf(145, 'theo'),
});

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
		const exchange = closedExchange(59, 61, 'mira', {
			status: 'published',
			summary: summaryOf(66, 'mira'),
		});
		expect(shape(build(messages, [exchange]))).toEqual(['question:59', 'said:61']);
	});

	it('shows a returned say as the opening of its own exchange, and the answer after it', () => {
		const scheduled = { ...said(61, 'agent', 'agent'), after: 600 } as Message;
		const returned = {
			seq: 70,
			kind: 'returned',
			to: 'agent',
			message: 61,
			owner: 'mira',
			text: 'Check the build.',
			at: AT,
		} as Message;
		const messages = [said(59, 'mira'), scheduled, returned, said(72, 'agent', 'mira')];
		const exchanges = [closedExchange(59, 61, 'mira'), closedExchange(70, 72, 'mira')];
		expect(shape(build(messages, exchanges))).toEqual([
			'question:59',
			'said:61',
			'returned:70',
			'said:72',
		]);
	});

	it('marks a scheduled say that a dismissal names, in the open and in a discussion', () => {
		const scheduled = { ...said(61, 'agent', 'agent'), after: 600 } as Message;
		const dismissed = { seq: 62, kind: 'dismissed', message: 61, at: AT } as Message;
		const open = build([said(59, 'mira'), scheduled, dismissed], []);
		expect(open.find((block) => block.type === 'message' && block.message.seq === 61)).toEqual({
			type: 'message',
			message: scheduled,
			role: 'said',
			dismissed: true,
		});
		const messages = [said(59, 'mira'), scheduled, dismissed, said(63, 'agent')];
		const [, discussion] = build(messages, [closedExchange(59, 63, 'mira')]);
		expect(discussion).toMatchObject({ type: 'discussion', count: 2 });
		if (discussion?.type !== 'discussion') throw new Error('Expected a discussion.');
		expect(discussion.items.map((item) => item.dismissed)).toEqual([true, undefined]);
	});

	it('keeps a returned say that lands in an open exchange inside its discussion', () => {
		const returned = {
			seq: 70,
			kind: 'returned',
			to: 'agent',
			message: 61,
			owner: 'mira',
			text: 'Check the build.',
			at: AT,
		} as Message;
		const scheduled = { ...said(61, 'agent', 'agent'), after: 600 } as Message;
		const messages = [said(59, 'mira'), scheduled, returned, said(72, 'agent'), said(75, 'agent')];
		expect(shape(build(messages, [closedExchange(59, 75, 'mira')]))).toEqual([
			'question:59',
			'discussion:59(4)',
		]);
	});

	it('keeps the closing mark when a person is the only one who spoke after the question', () => {
		// An exchange aborted after a follow-up: no agent replied, so there is nothing to show directly.
		const exchange = closedExchange(4, 9, 'mira');
		const blocks = build([said(4, 'mira'), said(9, 'mira')], [exchange]);
		expect(shape(blocks)).toEqual(['question:4', 'discussion:4(1)']);
		expect(blocks[1]).toMatchObject({ flag: 'No summary' });
	});

	it('notes a closed exchange that has no reply and no summary', () => {
		const blocks = build([said(75, 'theo')], [closedExchange(75, 75, 'theo')]);
		expect(shape(blocks)).toEqual(['question:75', 'note']);
		expect(blocks[1]).toMatchObject({ text: 'Closed without a summary' });
	});

	describe('a failed activation', () => {
		const attempt = (
			id: string,
			purpose: string,
			status: string,
			cause: string,
			attempt = 1,
		): object => ({ id, seat: 'assistant', purpose, attempt, outcome: { status, cause } });
		const limit = '400 invalid_request_error: You have reached your specified API usage limits.';
		const failures = new Map([
			['m1', limit],
			['s1', limit],
		]);
		const exhausted = (activations: object[], summary: object = { status: 'failed' }) =>
			({
				...closedExchange(75, 75, 'theo', summary),
				outcome: { kind: 'exhausted' },
				activations,
			}) as ExchangeView;

		it.each([
			[
				'names the seat the room gave up on, that it does not retry, and why',
				exhausted([
					attempt('m1', 'respond', 'failed', 'permanent'),
					attempt('m2', 'respond', 'abandoned', 'permanent', 2),
					attempt('s1', 'summary', 'failed', 'permanent'),
				]),
				failures,
				`Closed, assistant failed, the room does not retry this: ${limit}`,
			],
			[
				'counts the attempts of a transient failure',
				exhausted([attempt('m3', 'respond', 'failed', 'transient', 3)]),
				failures,
				'Closed, assistant failed, after 3 attempts',
			],
			[
				'names why a summary failed after a reply',
				{
					...closedExchange(75, 75, 'theo', { status: 'failed' }),
					activations: [attempt('s1', 'summary', 'failed', 'permanent')],
				} as ExchangeView,
				failures,
				`Closed, summary failed: assistant failed, the room does not retry this: ${limit}`,
			],
			[
				'keeps the plain line when this process heard no reason',
				exhausted([attempt('m1', 'respond', 'failed', 'permanent')]),
				undefined,
				'Closed, assistant failed, the room does not retry this',
			],
		])('%s', (_what, exchange, known, text) => {
			const blocks = build([said(75, 'theo')], [exchange], { failures: known });
			expect(blocks[1]).toMatchObject({ type: 'note', text });
		});

		it('flags a discussion whose reply the room gave up on', () => {
			const exchange = {
				...closed,
				outcome: { kind: 'exhausted' },
				activations: [attempt('m1', 'respond', 'failed', 'permanent')],
			} as ExchangeView;
			expect(build(thread, [exchange])[1]).toMatchObject({ flag: 'assistant failed' });
		});
	});

	it('flags a discussion whose summary is pending or failed', () => {
		const pending = closedExchange(98, 134, 'theo', { status: 'pending' });
		const blocks = build(thread.slice(0, -1), [pending]);
		expect(blocks[1]).toMatchObject({ type: 'discussion', flag: 'Summary pending' });
	});

	it('keeps the open exchange in the open, and ends with a live block', () => {
		const messages = [said(4, 'mira'), said(6, 'assistant', 'design'), said(9, 'mira')];
		const blocks = build(messages, [openExchange(4)], {
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
});

describe('cost and awaiting', () => {
	const usage = { input: 9000, output: 3300, cacheRead: 0, cacheWrite: 0 };
	const exchangeWith = (extra: Record<string, unknown>): ExchangeView =>
		({ ...closed, ...extra }) as ExchangeView;

	it('shows the cost of an exchange on its discussion, or its tokens, or nothing without usage', () => {
		const blocks = build(thread, [exchangeWith({ usage: { ...usage, cost: 0.0123 } })]);
		expect(blocks[1]).toMatchObject({ type: 'discussion', cost: '$0.0123', activations: 0 });
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

	it('shows an earlier exchange collapsed beside a newer open one, with the tail blocks before the live block', () => {
		const blocks = build([...thread, said(150, 'mira')], [closed, openExchange(150)], {
			open: { owner: 'mira' },
			tail: [{ type: 'note', text: 'Waiting.' }],
		});
		expect(shape(blocks)).toEqual([
			'question:98',
			'discussion:98(5)',
			'summary:145',
			'question:150',
			'note',
			'live',
		]);
	});
});
