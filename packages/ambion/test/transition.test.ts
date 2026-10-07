import { describe, expect, it } from 'vitest';
import type { CommitRequest } from '../src/hosting.ts';
import type { Seating } from '../src/journal/entries.ts';
import type { Kind, RoomEntry } from '../src/journal/journal.ts';
import { activationSpec } from '../src/room/activation.ts';
import type { RoomState } from '../src/room/fold.ts';
import { decide, type RoomDecision } from '../src/room/transition.ts';
import { viewOf } from '../src/room/view.ts';
import { evolve } from './support/evolve.ts';
import { owedOf, replayState } from './support/fold.ts';

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };

const product = { name: 'product', identity: 'Product.', attention: 'broadcast' } as const;
const writer = { name: 'writer', identity: 'Writer.', attention: 'broadcast' } as const;
const composition = (summaryWriter?: string, agents: Seating[] = [product, writer]): RoomEntry => ({
	kind: 'composition',
	seq: 1,
	body: {
		...(summaryWriter === undefined ? {} : { summaryWriter }),
		seated: agents,
		reserve: [{ name: 'reserve', identity: 'Reserve.', attention: 'broadcast' }],
		at,
	},
});

const message = (seq: number, body: object) =>
	({ kind: 'message', seq, body: { at, ...body } }) as RoomEntry;
const person = (seq = 2) =>
	message(seq, { kind: 'arrived', from: 'priya', subject: 'priya', identity: 'Person.' });
const question = (seq = 3) => message(seq, { kind: 'said', from: 'priya', text: 'Question.' });
const left = (seq: number) => message(seq, { kind: 'left', from: 'priya', subject: 'priya' });
const unseated = (seq: number) => message(seq, { kind: 'unseated', subject: 'writer' });
const seated = (seq: number) =>
	message(seq, { kind: 'seated', subject: 'writer', identity: 'Writer.', attention: 'broadcast' });
const closed = (seq = 4, through = 3): RoomEntry => ({
	kind: 'close',
	seq,
	body: { person: 'priya', from: 3, through, at, summaryWriter: 'writer' },
});
const lease = (id: string, seq: number): RoomEntry => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'running', expiresAt: now + 60_000, at, readThrough: 0 },
});

const fold = (...entries: RoomEntry[]) => replayState(entries, options);
/** A question, and the running activation of `seat` that answers it. */
const answering = (seat = 'product', first = composition()) =>
	fold(first, person(), question(), lease(`message:3:${seat}:1`, 4));
/** A closed exchange, and the running summary activation of the writer. */
const closing = () =>
	fold(composition('writer'), person(), question(), closed(), lease('closed:3:writer:1', 5));

const commit = (state: RoomState, request: CommitRequest, bytes?: number) =>
	decide(
		state,
		{ type: 'commit', ...(bytes === undefined ? {} : { bytes }), commit: request },
		now,
	);
const summary = (state: RoomState, intent: CommitRequest['intent'], bytes?: number) =>
	commit(state, { activation: 'closed:3:writer:1', key: 'summary', intent }, bytes);

const entryAt = (decision: RoomDecision<Kind>, seq: number): RoomEntry => {
	if (!('entry' in decision) || decision.entry === undefined) throw new Error('Expected an entry.');
	return { ...decision.entry, seq };
};
const refused = (category: string) => ({ refusal: { category } });

describe('room transition', () => {
	it.each([
		['no open exchange', fold(composition(), person()), 3, 3, 'obsolete'],
		['another exchange', fold(composition(), person(), question()), 2, 3, 'obsolete'],
		['a changed record', fold(composition(), person(), question(), person(4)), 3, 3, 'replan'],
		['live work', answering(), 3, 4, 'replan'],
		['a quiet exchange', fold(composition(), person(), question()), 3, 3, 'admitted'],
	] as const)('decides a close against %s', (_name, state, from, through, admission) => {
		const result = decide(state, { type: 'close', from, through }, now);
		if (admission === 'admitted') expect(result).toMatchObject({ entry: { kind: 'close' } });
		else expect(result).toEqual({ close: admission });
	});

	it('requires a recorded present human before accepting a delivery', () => {
		const absent = fold(composition(), person(), left(3));
		for (const from of ['priya', 'ghost']) {
			expect(decide(absent, { type: 'deliver', from, text: 'Orphan.' }, now)).toMatchObject({
				refusal: { category: 'not_present' },
			});
		}
	});

	it.each([
		[
			'an arrival of a present person',
			fold(composition(), person()),
			{ kind: 'arrived', from: 'priya', subject: 'priya', identity: 'Person.' },
		],
		[
			'a departure of an absent person',
			fold(composition(), person(), left(3)),
			{ kind: 'left', from: 'priya', subject: 'priya' },
		],
		[
			'a seating of a seated agent',
			fold(composition()),
			{ kind: 'seated', subject: 'product', identity: 'Product.', attention: 'broadcast' },
		],
		[
			'an unseating of a reserve agent',
			fold(composition()),
			{ kind: 'unseated', subject: 'reserve' },
		],
	] as const)('turns a recovered retry of %s into a no-op', (_case, state, change) => {
		expect(decide(state, { type: 'presence', change, route: false }, now)).toEqual({
			entry: undefined,
		});
	});

	it('grants ordinary response to any seated agent and only summary work to the writer', () => {
		const open = answering('product', composition('writer'));
		expect(activationSpec('message:3:product:1', open)).toMatchObject({
			purpose: { kind: 'respond', message: 3 },
		});
		expect(activationSpec('opened:3:product:1', open)).toBeUndefined();

		expect(activationSpec('closed:3:writer:1', closing())).toMatchObject({
			purpose: { kind: 'summarize', exchange: 3, person: 'priya', people: ['priya'], through: 3 },
		});
		expect(activationSpec('closed:3:product:1', closing())).toBeUndefined();
	});

	it('normalizes a closing said into a room-owned summary, skips freshness, and refuses other intents', () => {
		const state = closing();
		expect(summary(state, { kind: 'said', text: 'Done.' })).toMatchObject({
			entry: {
				kind: 'message',
				body: {
					kind: 'summary',
					from: 'writer',
					to: 'priya',
					text: 'Done.',
					covers: { from: 3, through: 3 },
					activation: 'closed:3:writer:1',
				},
			},
		});
		expect(summary(state, { kind: 'said', to: 'sam', text: 'No.' })).toMatchObject(
			refused('refused'),
		);
		// a forged intent does not override a summary grant
		expect(summary(state, { kind: 'seated', name: 'reserve' })).toMatchObject(refused('refused'));
	});

	it('requires current context for ordinary speech and refuses unknown recipients', () => {
		const state = answering();
		const say = (readThrough: number | undefined, to?: string) =>
			commit(state, {
				activation: 'message:3:product:1',
				key: 'say',
				...(readThrough === undefined ? {} : { readThrough }),
				intent: { kind: 'said', ...(to === undefined ? {} : { to }), text: 'Answer.' },
			});
		expect(say(undefined)).toMatchObject(refused('refused'));
		expect(say(0)).toMatchObject(refused('missed'));
		expect(say(3, 'nobody')).toMatchObject(refused('unknown_participant'));
		expect(say(3)).toMatchObject({ entry: { body: { kind: 'said', from: 'product' } } });
	});

	it('refuses a delivery, an ordinary say, and a closing summary over the byte cap, in bytes', () => {
		const state = fold(composition(), person());
		const deliver = (text: string, bytes?: number) =>
			decide(
				state,
				{ type: 'deliver', from: 'priya', text, ...(bytes === undefined ? {} : { bytes }) },
				now,
			);
		const accepted = { entry: { body: { kind: 'said' } } };
		expect(deliver('123456789', 8)).toMatchObject(refused('message_too_large'));
		expect(deliver('12345678', 8)).toMatchObject(accepted);
		expect(deliver('h\u00e9llo', 5)).toMatchObject(refused('message_too_large'));
		expect(deliver('h\u00e9llo', 6)).toMatchObject(accepted);
		expect(deliver('x'.repeat(10_000))).toMatchObject(accepted);

		const ordinary = commit(
			answering(),
			{
				activation: 'message:3:product:1',
				key: 'say',
				readThrough: 3,
				intent: { kind: 'said', text: 'Answer.' },
			},
			4,
		);
		expect(ordinary).toMatchObject(refused('message_too_large'));

		const done = { kind: 'said', text: 'Done.' } as const;
		expect(summary(closing(), done, 4)).toMatchObject(refused('message_too_large'));
		expect(summary(closing(), done, 5)).toMatchObject({ entry: { body: { kind: 'summary' } } });
		expect(summary(closing(), done)).toMatchObject({ entry: { body: { kind: 'summary' } } });
	});

	it('returns durable membership no-ops without writing another entry', () => {
		const state = answering();
		for (const intent of [
			{ kind: 'seated', name: 'product' },
			{ kind: 'unseated', name: 'reserve' },
		] as const) {
			expect(
				commit(state, { activation: 'message:3:product:1', key: intent.kind, intent }),
			).toEqual({ unchanged: intent });
		}
	});

	it.each([
		['the summary writer, fixed by default', 'writer', composition('writer')],
		[
			'an ordinary seat whose seating said fixed: true',
			'product',
			composition(undefined, [{ ...product, fixed: true }]),
		],
	])('refuses %s unseating itself', (_case, seat, first) => {
		const decision = commit(answering(seat, first), {
			activation: `message:3:${seat}:1`,
			key: 'leave',
			intent: { kind: 'unseated', name: seat },
		});
		expect(decision).toMatchObject(refused('refused'));
	});

	it('allows the summary writer to unseat itself when its seating said fixed: false, and removes its authority after the entry', () => {
		const state = answering(
			'writer',
			composition('writer', [product, { ...writer, fixed: false }]),
		);
		const decision = commit(state, {
			activation: 'message:3:writer:1',
			key: 'leave',
			intent: { kind: 'unseated', name: 'writer' },
		});
		expect(decision).toMatchObject({ entry: { body: { kind: 'unseated', subject: 'writer' } } });
		const after = evolve(evolve(state, entryAt(decision, 5), options), seated(6), options);
		expect(activationSpec('message:3:writer:1', after)).toBeUndefined();
	});

	it('keeps live lease expiry and release decisions independent of message commits, with usage when given', () => {
		const state = answering();
		const end = (reason: 'expired' | 'released', extra: object = {}) =>
			decide(
				state,
				{ type: 'end', id: 'message:3:product:1', reason, readThrough: 0, ...extra },
				now,
			);
		expect(end('expired')).toEqual({ entry: undefined });
		const plain = end('released');
		expect(plain).toMatchObject({ entry: { body: { phase: 'ended', reason: 'released' } } });
		expect(JSON.stringify(plain)).not.toContain('usage');
		const usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0, cost: 0.25 };
		expect(end('released', { usage })).toMatchObject({
			entry: { body: { phase: 'ended', usage } },
		});
	});

	const writes = {
		commit: (state: RoomState) =>
			commit(state, {
				activation: 'message:3:writer:1',
				key: 'say',
				intent: { kind: 'said', text: 'Answer.' },
			}),
		release: (state: RoomState) =>
			decide(
				state,
				{ type: 'release', id: 'message:3:writer:1', reason: 'released', readThrough: 3 },
				now,
			),
	};
	const ended: RoomEntry = {
		kind: 'lease',
		seq: 5,
		body: { id: 'message:3:writer:1', phase: 'ended', reason: 'revoked', at, readThrough: 0 },
	};
	it.each([
		['commit', 'the lease ended', ended, 'the lease ended'],
		['commit', 'the seat left the roster', unseated(5), 'the activation has no room grant'],
		['release', 'the lease ended', ended, 'the lease ended'],
		['release', 'the seat left the roster', unseated(5), 'the activation has no room grant'],
	] as const)(
		'refuses a %s as stale when %s after the seat checked',
		(write, _case, entry, reason) => {
			const state = evolve(answering('writer'), entry, options);
			expect(writes[write](state)).toEqual({ refusal: { category: 'stale', reason } });
		},
	);

	it('allows one active execution per seat across ordinary and closing work', () => {
		const state = replayState(
			[
				composition('writer'),
				person(),
				question(),
				closed(),
				lease('closed:3:writer:1', 5),
				message(6, { kind: 'said', from: 'priya', text: 'Next.', wakes: ['writer'] }),
			],
			options,
		);
		const claim = (from: RoomState) =>
			decide(from, { type: 'claim', id: 'message:6:writer:1', expiry: 100, deadline: 1_000 }, now);
		expect(claim(state)).toMatchObject(refused('stale'));
		const released = evolve(
			state,
			{
				kind: 'lease',
				seq: 7,
				body: { id: 'closed:3:writer:1', phase: 'ended', reason: 'released', at, readThrough: 3 },
			},
			options,
		);
		expect(claim(released)).toMatchObject({
			entry: { body: { id: 'message:6:writer:1', phase: 'running' } },
		});
	});

	it('preserves the detached summary view range and reserve identities', () => {
		const state = closing();
		const spec = activationSpec('closed:3:writer:1', state);
		if (spec === undefined) throw new Error('Expected summary grant.');
		const view = viewOf(spec, {
			name: 'room',
			now,
			state,
			live: new Map(),
			messagesSince: () => 0,
		});
		expect(view.through).toBe(3);
		expect(view.context.reserve).toEqual([{ name: 'reserve', identity: 'Reserve.' }]);
		expect(view.context.messages.map((message) => message.seq)).toEqual([2, 3]);
	});

	it('starts a new summary activation after reseating before close, and never revives one ended after close', () => {
		const start = [composition('writer'), person(), question()];
		const beforeClose = fold(...start, unseated(4), seated(5), closed(6, 5));
		expect(owedOf(beforeClose)).toMatchObject([{ seat: 'writer', position: 5 }]);
		const afterClose = fold(...start, closed(), unseated(5), seated(6));
		expect(owedOf(afterClose)).toEqual([]);
	});
});

describe('a scheduled say', () => {
	const schedule = { minDelaySeconds: 60, maxDelaySeconds: 3_600, waiting: 1 };
	const say = (
		state: RoomState,
		intent: CommitRequest['intent'],
		activation = 'message:3:product:1',
	) =>
		decide(
			state,
			{
				type: 'commit',
				commit: { activation, key: 'say', readThrough: state.lastSeq, intent },
				schedule,
			},
			now,
		);
	const because = (reason: RegExp) => ({ refusal: { category: 'refused', reason } });
	const later = (to = 'product', delaySeconds = 600) =>
		({ kind: 'said', to, text: 'Check the build.', delaySeconds }) as const;
	const scheduled = (seq = 5, delaySeconds = 600) =>
		message(seq, {
			kind: 'said',
			from: 'product',
			to: 'product',
			text: 'Check the build.',
			refs: ['file:///out.log'],
			delaySeconds,
			activation: 'message:3:product:1',
		});
	/** A question, the say that the answering seat scheduled, and the close of the exchange. */
	/** A seat at `presence` hears every arrival, and still no returned say of another seat. */
	const watcher = { ...writer, attention: 'presence' } as const;
	const waiting = (...more: RoomEntry[]) =>
		fold(
			composition(undefined, [product, watcher]),
			person(),
			question(),
			lease('message:3:product:1', 4),
			scheduled(),
			...more,
		);
	/** The close of the exchange, with no summary owed, so nothing else waits on the clock. */
	const quietClose = (seq: number, through: number): RoomEntry => ({
		kind: 'close',
		seq,
		body: { person: 'priya', from: 3, through, at },
	});
	const reconcile = (state: RoomState, at: number) =>
		decide(
			state,
			{
				type: 'reconcile',
				options: { resend: 5_000, attempts: 3, sent: new Map(), stopped: false },
			},
			at,
		);
	const released = (seq: number): RoomEntry => ({
		kind: 'lease',
		seq,
		body: { id: 'message:3:product:1', phase: 'ended', reason: 'released', at, readThrough: 5 },
	});
	const due = now + 600_000;

	it('writes a say to oneself with no owner, and wakes nobody', () => {
		expect(say(answering(), later())).toEqual({
			entry: {
				kind: 'message',
				body: {
					kind: 'said',
					to: 'product',
					text: 'Check the build.',
					delaySeconds: 600,
					at,
					activation: 'message:3:product:1',
					from: 'product',
				},
			},
		});
	});

	it('takes a scheduled say at any read position, and refuses an ordinary say that missed a message', () => {
		const state = answering();
		const commit = (readThrough: number | undefined, intent: CommitRequest['intent']) =>
			decide(
				state,
				{
					type: 'commit',
					commit: {
						activation: 'message:3:product:1',
						key: 'say',
						...(readThrough === undefined ? {} : { readThrough }),
						intent,
					},
					schedule,
				},
				now,
			);
		expect(commit(undefined, later())).toHaveProperty('entry');
		expect(commit(state.lastSeq - 1, later())).toHaveProperty('entry');
		expect(commit(state.lastSeq - 1, { kind: 'said', text: 'Hi.' })).toMatchObject({
			refusal: { category: 'missed' },
		});
	});

	it.each([
		['to another seat', answering(), later('writer'), /goes to its author/],
		['to a person', answering(), later('priya'), /goes to its author/],
		[
			'to the room',
			answering(),
			{ kind: 'said', text: 'Hi.', delaySeconds: 600 } as const,
			/author/,
		],
		[
			'to oneself with no delaySeconds',
			answering(),
			{ kind: 'said', to: 'product', text: 'Hi.' } as const,
			/cannot address yourself.*`schedule`/,
		],
		['under the least delaySeconds', answering(), later('product', 59), /from 60 to 3600 seconds/],
		['over the most delaySeconds', answering(), later('product', 3_601), /from 60 to 3600 seconds/],
		['in a part of a second', answering(), later('product', 60.5), /whole number/],
		['past the scheduled says of the seat', waiting(), later(), /at most 1 for one seat/],
	] as const)('refuses a say %s', (_case, state, intent, reason) => {
		expect(say(state, intent)).toMatchObject(because(reason));
	});

	it('takes a say with delaySeconds outside every exchange, and refuses one in a closing response', () => {
		const quiet = fold(composition(), person(), lease('message:2:product:1', 3));
		expect(quiet.exchange).toBeUndefined();
		expect(say(quiet, later(), 'message:2:product:1')).toHaveProperty('entry');
		expect(summary(closing(), { kind: 'said', text: 'Later.', delaySeconds: 600 })).toMatchObject(
			because(/cannot schedule/),
		);
	});

	it.each([
		['before', -1, false],
		['at', 0, true],
		['after', 1, true],
	] as const)('admits planning and writing %s the return deadline', (_case, offset, eligible) => {
		const state = waiting(released(6), quietClose(7, 6));
		const clock = due + offset;
		expect(reconcile(state, clock).steps).toEqual(eligible ? [{ type: 'return', message: 5 }] : []);
		const written = decide(state, { type: 'return', message: 5 }, clock);
		expect('entry' in written && written.entry !== undefined).toBe(eligible);
	});

	it('keeps an invalid due stamp ineligible in planning and writing', () => {
		const state = waiting(released(6), quietClose(7, 6));
		const invalid = {
			...state,
			scheduled: state.scheduled.map((say) => ({ ...say, due: 'invalid' })),
		};
		expect(reconcile(invalid, due).steps).toEqual([]);
		expect(decide(invalid, { type: 'return', message: 5 }, due)).toEqual({ entry: undefined });
	});

	it('waits outside live work, returns when due after the close, and opens an exchange with no person', () => {
		const closedWaiting = waiting(released(6), quietClose(7, 6));
		expect(closedWaiting.scheduled).toEqual([
			{
				seq: 5,
				seat: 'product',
				due: new Date(due).toISOString(),
				text: 'Check the build.',
				refs: ['file:///out.log'],
			},
		]);
		const early = reconcile(closedWaiting, now + 1_000);
		expect(early.steps).toEqual([]);
		expect(early.effects.alarmAt).toBe(due);
		const returned = {
			kind: 'system',
			at: new Date(due).toISOString(),
			to: 'product',
			returns: 5,
			text: 'Check the build.',
			refs: ['file:///out.log'],
		};
		expect(reconcile(closedWaiting, due).steps).toEqual([{ type: 'return', message: 5 }]);
		const written = decide(closedWaiting, { type: 'return', message: 5 }, due);
		expect(written).toEqual({
			entry: { kind: 'message', body: { ...returned, wakes: ['product'] } },
		});
		const after = evolve(closedWaiting, entryAt(written, 8), options);
		expect(after.scheduled).toEqual([]);
		expect(after.exchange).toEqual({ from: 8, at: returned.at });
		expect(after.due.map((owed) => owed.id)).toEqual(['message:8:product:1']);
		expect(decide(after, { type: 'return', message: 5 }, due)).toEqual({ entry: undefined });
		// A dismissal that loses the race to the due time changes nothing.
		expect(decide(after, { type: 'dismiss', message: 5 }, due)).toEqual({ entry: undefined });
	});

	it('returns the say after the close that the same pass writes', () => {
		const steps = reconcile(waiting(released(6)), due).steps;
		expect(steps.map((step) => step.type)).toEqual(['close', 'return']);
	});

	it('writes the ending of a lease first, then the close, then the returned say', () => {
		// A crash left the lease running past its expiry. The say returns only
		// after the close, so the record is the same whether the host crashed.
		const expired = waiting();
		const steps = reconcile(expired, due).steps;
		expect(steps.map((step) => step.type)).toEqual(['end']);
		const [ending] = steps;
		if (ending?.type !== 'end') throw new Error('Expected the ending.');
		const ended = evolve(expired, entryAt(decide(expired, ending, due), 6), options);
		expect(reconcile(ended, due).steps.map((step) => step.type)).toEqual(['close', 'return']);
	});

	it("joins another person's open exchange, and leaves its owner", () => {
		const sam = [
			message(8, { kind: 'arrived', from: 'sam', subject: 'sam', identity: 'Person.' }),
			message(9, { kind: 'said', from: 'sam', text: 'Another question.' }),
		];
		const state = waiting(released(6), quietClose(7, 6), ...sam);
		const written = decide(state, { type: 'return', message: 5 }, due);
		const after = evolve(state, entryAt(written, 10), options);
		expect(after.exchange).toMatchObject({ person: 'sam', from: 9 });
		expect(after.scheduled).toEqual([]);
	});

	it('waits for its seat to take its seat again, then returns', () => {
		const empty = composition(undefined, [watcher]);
		const away = waiting(released(6), quietClose(7, 6), { ...empty, seq: 8 });
		expect(away.scheduled).toHaveLength(1);
		expect(reconcile(away, due).steps).toEqual([]);
		expect(decide(away, { type: 'return', message: 5 }, due)).toEqual({ entry: undefined });
		const back = evolve(away, { ...composition(undefined, [product, watcher]), seq: 9 }, options);
		expect(reconcile(back, due).steps.map((step) => step.type)).toEqual(['return']);
	});

	const dismiss = (state: RoomState, handle: number, activation = 'message:3:product:1') =>
		decide(
			state,
			{
				type: 'commit',
				commit: { activation, key: 'dismiss', intent: { kind: 'dismissed', message: handle } },
				schedule,
			},
			now,
		);

	it('lets a seat dismiss its own scheduled say: no wake, no return, a free place, and unchanged after', () => {
		const state = waiting();
		const decision = dismiss(state, 5);
		expect(decision).toEqual({
			entry: {
				kind: 'message',
				body: {
					kind: 'dismissed',
					message: 5,
					at,
					activation: 'message:3:product:1',
					from: 'product',
				},
			},
		});
		const after = evolve(state, entryAt(decision, 6), options);
		expect(after.scheduled).toEqual([]);
		expect(after.deliveries.get(6)).toEqual({ wakes: [], steers: [] });
		expect(decide(after, { type: 'return', message: 5 }, due)).toEqual({ entry: undefined });
		expect(dismiss(after, 5)).toEqual({ unchanged: { kind: 'dismissed', message: 5 } });
		expect(say(after, later())).toHaveProperty('entry');
		// A say that returned before the seat dismissed it reads the same way.
		const raced = waiting();
		const back = evolve(
			raced,
			entryAt(decide(raced, { type: 'return', message: 5 }, due), 6),
			options,
		);
		expect(dismiss(back, 5)).toEqual({ unchanged: { kind: 'dismissed', message: 5 } });
	});

	it.each([
		['the say of another seat', 5, 'message:3:writer:1', /say of 'product'/],
		['a handle that names no say', 3, 'message:3:product:1', /not the handle/],
	])('refuses a seat that dismisses %s', (_case, handle, activation, reason) => {
		const state = waiting(lease('message:3:writer:1', 6));
		expect(dismiss(state, handle, activation)).toMatchObject(because(reason));
	});

	it('refuses a dismissal in a summary activation', () => {
		expect(summary(closing(), { kind: 'dismissed', message: 5 })).toMatchObject(
			because(/cannot submit/),
		);
	});

	it('lets the host dismiss any scheduled say with no author, and write nothing for one gone', () => {
		// A running lease of another seat: an entry with no author steers no seat.
		const state = waiting(lease('message:3:writer:1', 6));
		const decision = decide(state, { type: 'dismiss', message: 5 }, now);
		expect(decision).toEqual({
			entry: { kind: 'message', body: { kind: 'dismissed', message: 5, at } },
		});
		const after = evolve(state, entryAt(decision, 7), options);
		expect(after.deliveries.get(7)).toEqual({ wakes: [], steers: [] });
		expect(after.scheduled).toEqual([]);
		expect(decide(after, { type: 'dismiss', message: 5 }, now)).toEqual({ entry: undefined });
	});

	it("lists the seat's own scheduled says in its response view, with the seq as the handle", () => {
		const state = waiting(lease('message:3:writer:1', 6));
		const view = (activation: string) => {
			const spec = activationSpec(activation, state);
			if (spec === undefined) throw new Error('Expected a grant.');
			return viewOf(spec, { name: 'room', now, state, live: new Map(), messagesSince: () => 0 });
		};
		expect(view('message:3:product:1').context.scheduled).toEqual([
			{
				seq: 5,
				seat: 'product',
				due: new Date(due).toISOString(),
				text: 'Check the build.',
				refs: ['file:///out.log'],
			},
		]);
		expect(view('message:3:writer:1').context.scheduled).toBeUndefined();
	});

	it('steers no seat with a say to oneself, only its target with a directed post, and each seat with a post to the room', () => {
		const state = fold(
			composition(undefined, [product, watcher]),
			person(),
			question(),
			lease('message:3:product:1', 4),
			lease('message:3:writer:1', 5),
			scheduled(6),
			message(7, { kind: 'system', to: 'product', returns: 6, text: 'Check.' }),
			message(8, { kind: 'system', to: 'product', text: 'lab: process build ended.' }),
			message(9, { kind: 'system', text: 'ci: build 412 failed.' }),
		);
		expect(state.deliveries.get(6)).toEqual({ wakes: [], steers: [] });
		// A post with `to` steers its target alone, and a post to the room steers each seat at work.
		expect(state.deliveries.get(8)?.steers.map((steer) => steer.seat)).toEqual(['product']);
		expect(
			state.deliveries
				.get(9)
				?.steers.map((steer) => steer.seat)
				.sort(),
		).toEqual(['product', 'writer']);
		expect(state.deliveries.get(7)).toEqual({
			wakes: [],
			steers: [{ seat: 'product', activation: 'message:3:product:1' }],
		});
	});

	it.each([
		['an unseating of its seat', message(6, { kind: 'unseated', subject: 'product' })],
		['a cancellation after it', { kind: 'cancel', seq: 6, body: { at } } as RoomEntry],
	])('drops a say at %s', (_case, entry) => {
		const state = waiting(entry);
		expect(state.scheduled).toEqual([]);
		expect(reconcile(state, due).steps.some((step) => step.type === 'return')).toBe(false);
		expect(decide(state, { type: 'return', message: 5 }, due)).toEqual({ entry: undefined });
	});
});
