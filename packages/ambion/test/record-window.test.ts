/**
 * The record window: the one rule by which the room bounds the record of a
 * view. The room keeps the newest messages under its cap, then under the
 * token limit of the seat, never splits a summarised range, and keeps the
 * open exchange whole. The view is pure, so every case hands it a value, and
 * the snapshot pins the rendered context of each case.
 */
import { describe, expect, it } from 'vitest';
import { pi } from '../../pi/src/index.ts';
import { renderActivation } from '../src/execution/render.ts';
import { createRuntime, roomRuntime, tokenWindowOf } from '../src/host/runtime.ts';
import type { Entry } from '../src/journal/journal.ts';
import type { ActivationSpec } from '../src/protocol.ts';
import type { RoomState } from '../src/room/fold.ts';
import { type RoomFacts, viewOf } from '../src/room/view.ts';
import type { Message, Seq } from '../src/types.ts';
import { replayState } from './support/fold.ts';
import { scriptedAgent } from './support/room.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

function said(seq: Seq, text = 'aaaa'): Message {
	return { kind: 'said', seq, at, from: 'priya', text };
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

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
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

const summarizeWide: ActivationSpec = {
	...summarize,
	purpose: { kind: 'summarize', person: 'priya', people: ['priya'], exchange: 101, through: 118 },
};

// Each line of `short` renders as "#N [priya] aaaa", 15 characters.
const short = replayState([composition, ...[2, 3, 4, 5].map((seq) => message(said(seq)))], options);
const pinned: RoomState = { ...short, exchange: { owner: 'priya', from: 3, at } };
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

/** 149 messages of mixed length, two summarised ranges, and an exchange open from 120. */
function wideState(): RoomState {
	const record: Message[] = [];
	for (let seq = 2; seq <= 150; seq += 1) {
		if (seq === 40) record.push(summary(40, 20, 35));
		else if (seq === 100) record.push(summary(100, 60, 95));
		else record.push(said(seq, 'x'.repeat(((seq * 7) % 23) + 1)));
	}
	const state = replayState([composition, ...record.map(message)], options);
	return { ...state, exchange: { owner: 'priya', from: 120, at } };
}
const wide = wideState();

/** A runtime whose registry holds `chars`: one token per character, so a limit reads as a length. */
const runtime = roomRuntime(
	createRuntime({ estimators: { chars: (text: string) => text.length } }),
	'window',
);
const chars = 'chars';

interface Case {
	state: RoomState;
	spec: ActivationSpec;
	/** The room cap. Absent is unbounded. */
	cap?: number;
	/** The token limit of the seat, and the estimator it names. Absent sets no limit. */
	tokens?: number;
	estimator?: string;
	/** The first seq the view holds, and how many messages it leaves out. */
	from: Seq;
	omitted?: number;
	/** The seq the view acknowledges. A window moves the floor and leaves this position. */
	through?: Seq;
}

/** The view of one case, as the room serves it, and the context the seat reads. */
function read({ state, spec, cap, tokens, estimator }: Case) {
	const agent = scriptedAgent('worker', 'Works.', {
		instructions: 'Work.',
		...(tokens === undefined ? {} : { activationTokenLimit: tokens }),
		...(estimator === undefined ? {} : { estimateTokens: estimator }),
	});
	const window = tokenWindowOf(agent, runtime);
	const facts: RoomFacts = {
		name: 'window',
		now,
		state,
		live: new Map([['worker', ['message:2:worker:0']]]),
		messagesSince: () => 0,
		...(cap === undefined && window === undefined
			? {}
			: {
					limits: {
						messages: cap ?? Number.POSITIVE_INFINITY,
						...(window === undefined ? {} : { tokens: window }),
					},
				}),
	};
	const view = viewOf(spec, facts);
	return { view, rendered: renderActivation(view, agent).context };
}

describe('the room windows the record', () => {
	it.each<[string, Case]>([
		['the whole record with no bound', { state: short, spec: respond, from: 2 }],
		[
			'a cap serves the newest messages and counts what it drops',
			{ state: short, spec: respond, cap: 2, from: 4, omitted: 2, through: short.lastSeq },
		],
		[
			'a cap serves the open exchange whole',
			{ state: pinned, spec: respond, cap: 1, from: 3, omitted: 1 },
		],
		[
			'a cap moves the floor past a summarised range and keeps the summary',
			{ state: long, spec: respond, cap: 6, from: 7, omitted: 5 },
		],
		[
			'an infinite cap reports nothing',
			{ state: short, spec: respond, cap: Number.POSITIVE_INFINITY, from: 2 },
		],
		[
			'a cap serves the closing exchange whole to a summary purpose',
			{ state: short, spec: summarize, cap: 1, from: 3, omitted: 1 },
		],
		[
			'a token limit keeps the newest lines that fit',
			{
				state: short,
				spec: respond,
				tokens: 30,
				estimator: chars,
				from: 4,
				omitted: 2,
				through: short.lastSeq,
			},
		],
		[
			'a token limit keeps at least the newest line',
			{ state: short, spec: respond, tokens: 1, estimator: chars, from: 5, omitted: 3 },
		],
		[
			'a token limit pins the open exchange whole',
			{ state: pinned, spec: respond, tokens: 1, estimator: chars, from: 3, omitted: 1 },
		],
		[
			'a token limit counts a summarised range once',
			{ state: long, spec: respond, tokens: 1000, estimator: chars, from: 2 },
		],
		[
			'a token limit keeps a summarised range whole',
			{ state: long, spec: respond, tokens: 100, estimator: chars, from: 4, omitted: 2 },
		],
		[
			'a token limit stops above a summarised range that does not fit',
			{ state: long, spec: respond, tokens: 80, estimator: chars, from: 7, omitted: 5 },
		],
		[
			'a token limit stops at the cap',
			{ state: short, spec: respond, cap: 3, tokens: 4000, estimator: chars, from: 3, omitted: 1 },
		],
		[
			'a token limit keeps the exchange of a summary purpose whole',
			{ state: short, spec: summarize, tokens: 1, estimator: chars, from: 3, omitted: 1 },
		],
		[
			'a long record that fits the token limit',
			{ state: wide, spec: respond, tokens: 100_000, estimator: chars, from: 2 },
		],
		[
			'a long record cut deep by the token limit',
			{ state: wide, spec: respond, tokens: 900, estimator: chars, from: 115, omitted: 113 },
		],
		[
			'a long record under a cap and a token limit',
			{
				state: wide,
				spec: respond,
				cap: 100,
				tokens: 1500,
				estimator: chars,
				from: 56,
				omitted: 54,
			},
		],
		[
			'a long record under a cap below the open exchange',
			{
				state: wide,
				spec: respond,
				cap: 20,
				tokens: 200,
				estimator: chars,
				from: 120,
				omitted: 118,
			},
		],
		[
			'a long record for a summary purpose',
			{ state: wide, spec: summarizeWide, tokens: 500, estimator: chars, from: 99, omitted: 97 },
		],
		[
			'a long record by the default estimate',
			{ state: wide, spec: respond, tokens: 300, from: 106, omitted: 104 },
		],
	])('%s', (_name, one) => {
		const { view, rendered } = read(one);
		const { purpose } = one.spec;
		const through = purpose.kind === 'summarize' ? purpose.through : Number.POSITIVE_INFINITY;
		// The view is the tail of the record the purpose may read, from `from` on.
		expect(view.context.messages.map((item) => item.seq)).toEqual(
			one.state.messages
				.filter((item) => item.seq >= one.from && item.seq <= through)
				.map((item) => item.seq),
		);
		expect(view.context.omitted).toBe(one.omitted);
		if (one.through !== undefined) expect(view.through).toBe(one.through);
		expect(rendered).toMatchSnapshot();
	});
});

describe('the view of one message', () => {
	it.each([
		['reads a message by its seq', short, respond, 3, [3]],
		['reads a message below the cap and the token window', short, respond, 2, [2]],
		['reads a message inside a summarised range and never folds it', long, respond, 5, [5]],
		['reads nothing for a seq the record does not hold', short, respond, 9, []],
		['reads nothing past the exchange of a summary purpose', long, summarize, 7, []],
	])('%s', (_name, state, spec, seq, seqs) => {
		const facts: RoomFacts = {
			name: 'window',
			now,
			state,
			live: new Map(),
			messagesSince: () => 0,
			limits: { messages: 1, tokens: { limit: 1, estimate: (text: string) => text.length } },
		};
		const view = viewOf(spec, facts, seq);
		expect(view.context.messages.map((item) => item.seq)).toEqual(seqs);
		// No window applies to one message, so the view leaves nothing out.
		expect(view.context.omitted).toBeUndefined();
	});
});

describe('the estimator a seat names', () => {
	it('is a name, needs a limit, and stays on the executor', () => {
		const base = { instructions: 'Read.', model: 'scripted/reader' };
		expect(() => pi({ ...base, estimateTokens: chars })).toThrow(/activationTokenLimit/);
		expect(() => pi({ ...base, activationTokenLimit: 0 })).toThrow(/positive integer/);
		expect(() => pi({ ...base, activationTokenLimit: 5, estimateTokens: '' })).toThrow(
			/name of an estimator/,
		);
		const executor = pi({ ...base, activationTokenLimit: 500, estimateTokens: chars });
		expect(executor.activationTokenLimit).toBe(500);
		expect(executor.estimateTokens).toBe(chars);
	});

	it('resolves from the registry of the runtime, and a name it does not hold throws', () => {
		const limited = (estimateTokens?: string) =>
			scriptedAgent('reader', 'Reads.', {
				activationTokenLimit: 10,
				...(estimateTokens === undefined ? {} : { estimateTokens }),
			});
		expect(tokenWindowOf(scriptedAgent('reader'), runtime)).toBeUndefined();
		expect(tokenWindowOf(limited(), runtime)?.estimate('abcde')).toBe(2);
		expect(tokenWindowOf(limited(chars), runtime)?.estimate('abcde')).toBe(5);
		expect(() => tokenWindowOf(limited('words'), runtime)).toThrow(
			"Agent 'reader' names estimator 'words', and the runtime holds none by that name.",
		);
	});

	it('registers a function under a new name only', () => {
		const estimate = (text: string) => text.length;
		expect(() => createRuntime({ estimators: { length: estimate } })).toThrow(/is built in/);
		expect(() =>
			createRuntime({ estimators: { chars: 'text' as unknown as typeof estimate } }),
		).toThrow('Runtime estimators.chars must be a function.');
	});
});
