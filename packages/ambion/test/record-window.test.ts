/**
 * The record window: a seat with a token limit reads the newest part of the
 * record that fits, plus the open exchange whole. The room pages the record
 * and never splits a summarised range. Both halves are pure, so every test
 * hands them a value.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { windowToLimit } from '../src/execution/render.ts';
import type { Entry } from '../src/journal/journal.ts';
import type { ActivationSpec, ViewRange } from '../src/protocol.ts';
import { foldRoom, type RoomState } from '../src/room/fold.ts';
import { type RoomFacts, viewOf } from '../src/room/view.ts';
import type { Message, Seq } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

/** One token per character, so a limit reads as a length. */
const byLength = (text: string): number => text.length;

function said(seq: Seq, text: string): Message {
	return { kind: 'said', seq, at, from: 'priya', text };
}

describe('windowToLimit', () => {
	it('keeps the newest lines that fit the limit', () => {
		const record = [said(2, 'aaaa'), said(3, 'bbbb'), said(4, 'cccc')];
		// Each line renders as "[priya] xxxx" (12 chars). A limit of 30 holds two.
		const window = windowToLimit(record, byLength, 30);
		expect(window.kept.map((message) => message.seq)).toEqual([3, 4]);
		expect(window.from).toBe(3);
	});

	it('keeps at least the newest line when one line exceeds the limit', () => {
		const record = [said(2, 'aaaa'), said(3, 'bbbb')];
		const window = windowToLimit(record, byLength, 1);
		expect(window.kept.map((message) => message.seq)).toEqual([3]);
	});

	it('pins the open exchange whole, even past the limit', () => {
		const record = [said(2, 'aaaa'), said(3, 'bbbb'), said(4, 'cccc')];
		const window = windowToLimit(record, byLength, 1, 2);
		expect(window.kept.map((message) => message.seq)).toEqual([2, 3, 4]);
		expect(window.from).toBe(2);
	});

	it('counts a summarised range once and never splits it', () => {
		const summary: Message = {
			kind: 'summary',
			seq: 5,
			at,
			from: 'writer',
			to: 'priya',
			text: 'Done.',
			covers: { from: 2, through: 3 },
		};
		const record = [said(2, 'aaaa'), said(3, 'bbbb'), summary, said(6, 'cccc')];
		// A large limit keeps everything: the fold stands for seqs 2 and 3.
		const window = windowToLimit(record, byLength, 1000);
		expect(window.kept.map((message) => message.seq)).toEqual([2, 3, 5, 6]);
		expect(window.from).toBe(2);
	});
});

// -- the room pages the record ------------------------------------------------

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		agents: [{ name: 'worker', identity: 'Works.', attention: 'broadcast' }],
		available: [],
		at,
	},
};

function message(seq: Seq, body: Message): Entry {
	return { kind: 'message', seq, body: withoutSeq(body) } as Entry;
}

/** The journal assigns the place, so an entry body carries none. */
function withoutSeq(body: Message): Omit<Message, 'seq'> {
	const { seq: _seq, ...rest } = body;
	return rest;
}

function respondSpec(): ActivationSpec {
	return {
		id: 'message:2:worker:0',
		seat: 'worker',
		attempt: 0,
		purpose: { kind: 'respond', message: 2 },
	};
}

function facts(state: RoomState): RoomFacts {
	return {
		name: 'window',
		now,
		state,
		live: new Map([['worker', ['message:2:worker:0']]]),
		messagesSince: () => 0,
	};
}

describe('the room pages the record', () => {
	const entries: Entry[] = [
		composition,
		message(2, said(2, 'one')),
		message(3, said(3, 'two')),
		message(4, said(4, 'three')),
		message(5, said(5, 'four')),
	];

	it('reads the whole record without a range', () => {
		const state = foldRoom(entries, options);
		const view = viewOf(respondSpec(), facts(state));
		expect(view.context.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5]);
		expect(view.context.earliest).toBeUndefined();
	});

	it('reads one bounded page from the tail and reports the record floor', () => {
		const state = foldRoom(entries, options);
		const view = viewOf(respondSpec(), facts(state), { limit: 2 });
		expect(view.context.messages.map((m) => m.seq)).toEqual([4, 5]);
		expect(view.context.earliest).toBe(2);
	});

	it('reads a page before a cursor', () => {
		const state = foldRoom(entries, options);
		const view = viewOf(respondSpec(), facts(state), { before: 4, limit: 2 });
		expect(view.context.messages.map((m) => m.seq)).toEqual([2, 3]);
	});

	it('never splits a summarised range across the page floor', () => {
		// A summary at seq 8 stands for the closed range [4, 6].
		const summary: Message = {
			kind: 'summary',
			seq: 8,
			at,
			from: 'worker',
			to: 'priya',
			text: 'Done.',
			covers: { from: 4, through: 6 },
		};
		const longer: Entry[] = [
			composition,
			message(2, said(2, 'one')),
			message(3, said(3, 'two')),
			message(4, said(4, 'three')),
			message(5, said(5, 'four')),
			message(6, said(6, 'five')),
			message(7, said(7, 'six')),
			message(8, summary),
			message(9, said(9, 'seven')),
			message(10, said(10, 'eight')),
		];
		const state = foldRoom(longer, options);
		// A limit of 6 starts at seq 5, inside the covered range [4, 6]. The floor
		// moves up past the range, so the page drops the split source and keeps
		// the summary that stands for it.
		const view = viewOf(respondSpec(), facts(state), { limit: 6 });
		expect(view.context.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10]);
	});

	it('reads the whole record when the range is malformed', () => {
		const state = foldRoom(entries, options);
		const bad: ViewRange[] = [
			{ limit: 0 },
			{ limit: -5 },
			{ limit: Number.NaN },
			{ limit: 2, before: -1 },
		];
		for (const range of bad) {
			const view = viewOf(respondSpec(), facts(state), range);
			expect(view.context.messages.map((m) => m.seq)).toEqual([2, 3, 4, 5]);
			expect(view.context.earliest).toBeUndefined();
		}
	});
});

describe('activationTokenLimit validation', () => {
	const base = {
		instructions: 'Read.',
		model: 'scripted/reader',
	};

	it('rejects an estimator without a limit', () => {
		expect(() => pi({ ...base, estimateTokens: (text: string) => text.length })).toThrow(
			/activationTokenLimit/,
		);
	});

	it('rejects a nonpositive limit', () => {
		expect(() => pi({ ...base, activationTokenLimit: 0 })).toThrow(/positive integer/);
	});

	it('keeps the limit and estimator on the executor', () => {
		const estimate = (text: string) => text.length;
		const executor = pi({ ...base, activationTokenLimit: 500, estimateTokens: estimate });
		expect(executor.activationTokenLimit).toBe(500);
		expect(executor.estimateTokens).toBe(estimate);
	});
});
