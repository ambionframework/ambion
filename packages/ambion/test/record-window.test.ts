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
import type { RoomState } from '../src/room/fold.ts';
import { type RoomFacts, viewOf } from '../src/room/view.ts';
import type { Message, Seq } from '../src/types.ts';
import { replayState } from './support/fold.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

/** One token per character, so a limit reads as a length. */
const byLength = (text: string): number => text.length;

function said(seq: Seq): Message {
	return { kind: 'said', seq, at, from: 'priya', text: 'aaaa' };
}

/** A summary that stands for the closed range [from, through]. */
function summary(seq: Seq, from: Seq, through: Seq): Message {
	return {
		kind: 'summary',
		seq,
		at,
		from: 'worker',
		to: 'priya',
		text: 'Done.',
		covers: { from, through },
	};
}

describe('windowToLimit', () => {
	// Each line renders as "[priya] aaaa" (12 chars). A limit of 30 holds two.
	it.each([
		[
			'keeps the newest lines that fit the limit',
			[said(2), said(3), said(4)],
			30,
			undefined,
			[3, 4],
			3,
		],
		[
			'keeps at least the newest line when one line exceeds the limit',
			[said(2), said(3)],
			1,
			undefined,
			[3],
			3,
		],
		[
			'pins the open exchange whole, even past the limit',
			[said(2), said(3), said(4)],
			1,
			2,
			[2, 3, 4],
			2,
		],
		// A large limit keeps everything: the fold stands for seqs 2 and 3.
		[
			'counts a summarised range once and never splits it',
			[said(2), said(3), summary(5, 2, 3), said(6)],
			1000,
			undefined,
			[2, 3, 5, 6],
			2,
		],
	])('%s', (_name, record, limit, open, kept, from) => {
		const window = windowToLimit(record, byLength, limit, open);
		expect(window.kept.map((message) => message.seq)).toEqual(kept);
		expect(window.from).toBe(from);
	});
});

// -- the room pages and caps the record ---------------------------------------

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

/** The journal assigns the place, so an entry body carries none. */
function message(body: Message): Entry {
	const { seq, ...rest } = body;
	return { kind: 'message', seq, body: rest } as Entry;
}

const respond: ActivationSpec = {
	id: 'message:2:worker:0',
	seat: 'worker',
	attempt: 0,
	purpose: { kind: 'respond', message: 2 },
};

const summarize: ActivationSpec = {
	id: 'summary:2:writer:0',
	seat: 'worker',
	attempt: 0,
	purpose: { kind: 'summarize', person: 'priya', people: ['priya'], exchange: 3, through: 5 },
};

const short = replayState([composition, ...[2, 3, 4, 5].map((seq) => message(said(seq)))], options);
// A summary at seq 8 stands for the closed range [4, 6].
const long = replayState(
	[
		composition,
		...[2, 3, 4, 5, 6, 7].map((seq) => message(said(seq))),
		message(summary(8, 4, 6)),
		...[9, 10].map((seq) => message(said(seq))),
	],
	options,
);

/** Read one view and name what the tests compare. */
function read(state: RoomState, spec: ActivationSpec, cap?: number, range?: ViewRange) {
	const facts: RoomFacts = {
		name: 'window',
		now,
		state,
		live: new Map([['worker', ['message:2:worker:0']]]),
		messagesSince: () => 0,
		...(cap === undefined ? {} : { limits: { messages: cap } }),
	};
	const view = viewOf(spec, facts, range);
	const { earliest, omitted } = view.context;
	return {
		seqs: view.context.messages.map((m) => m.seq),
		earliest,
		omitted,
		through: view.through,
	};
}

describe('the room pages the record', () => {
	it.each([
		['the whole record without a range', undefined, [2, 3, 4, 5], undefined],
		['one bounded page from the tail, with the record floor', { limit: 2 }, [4, 5], 2],
		['a page before a cursor', { before: 4, limit: 2 }, [2, 3], 2],
		['the whole record for a zero limit', { limit: 0 }, [2, 3, 4, 5], undefined],
		['the whole record for a negative limit', { limit: -5 }, [2, 3, 4, 5], undefined],
		[
			'the whole record for a limit that is not a number',
			{ limit: Number.NaN },
			[2, 3, 4, 5],
			undefined,
		],
		['the whole record for a negative cursor', { limit: 2, before: -1 }, [2, 3, 4, 5], undefined],
	])('reads %s', (_name, range: ViewRange | undefined, seqs, earliest) => {
		expect(read(short, respond, undefined, range)).toMatchObject({ seqs, earliest });
	});

	it('never splits a summarised range across the page floor', () => {
		// A limit of 6 starts at seq 5, inside the covered range [4, 6]. The floor
		// moves up past the range, so the page drops the split source and keeps
		// the summary that stands for it.
		expect(read(long, respond, undefined, { limit: 6 }).seqs).toEqual([7, 8, 9, 10]);
	});
});

describe('the room caps the record', () => {
	const pinned: RoomState = { ...short, exchange: { owner: 'priya', from: 3, at } };
	it.each([
		[
			'serves the newest messages and counts what it drops',
			short,
			respond,
			2,
			undefined,
			{ seqs: [4, 5], earliest: 4, omitted: 2, through: short.lastSeq },
		],
		[
			'serves the open exchange whole below the cap',
			pinned,
			respond,
			1,
			undefined,
			{ seqs: [3, 4, 5], omitted: 1 },
		],
		[
			'moves the floor past a summarised range and keeps the summary',
			long,
			respond,
			6,
			undefined,
			{ seqs: [7, 8, 9, 10], omitted: 5 },
		],
		[
			'stops a page at the capped floor',
			short,
			respond,
			3,
			{ before: 5, limit: 2 },
			{ seqs: [3, 4], earliest: 3, omitted: 1 },
		],
		[
			'serves no page below the capped floor',
			short,
			respond,
			3,
			{ before: 3, limit: 2 },
			{ seqs: [], omitted: 1 },
		],
		[
			'reports nothing for an infinite cap without a range',
			short,
			respond,
			Number.POSITIVE_INFINITY,
			undefined,
			{ seqs: [2, 3, 4, 5], earliest: undefined, omitted: undefined },
		],
		[
			'serves the closing exchange whole to a summary purpose',
			short,
			summarize,
			1,
			undefined,
			{ seqs: [3, 4, 5], omitted: 1 },
		],
	])('%s', (_name, state, spec, cap, range: ViewRange | undefined, expected) => {
		expect(read(state, spec, cap, range)).toMatchObject(expected);
	});
});

describe('activationTokenLimit validation', () => {
	it('rejects an estimator without a limit and a nonpositive limit, and keeps both on the executor', () => {
		const base = { instructions: 'Read.', model: 'scripted/reader' };
		const estimate = (text: string) => text.length;
		expect(() => pi({ ...base, estimateTokens: estimate })).toThrow(/activationTokenLimit/);
		expect(() => pi({ ...base, activationTokenLimit: 0 })).toThrow(/positive integer/);
		const executor = pi({ ...base, activationTokenLimit: 500, estimateTokens: estimate });
		expect(executor.activationTokenLimit).toBe(500);
		expect(executor.estimateTokens).toBe(estimate);
	});
});
