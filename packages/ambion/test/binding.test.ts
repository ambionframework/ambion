/**
 * The binding between the room's verified rules and the code that runs
 * them. A proof is about a rule's body; it reaches the room only when a
 * decision runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the decision
 * follows it.
 */
import { describe, expect, it, vi } from 'vitest';
import { encodeActivationId } from '../src/activation-id.ts';
import { createRuntime, defineAgent, defineHuman, startRoom } from '../src/index.ts';
import type { Entry } from '../src/journal/journal.ts';
import { validateRoomBody } from '../src/journal/validate.ts';
import type { CommitRequest } from '../src/protocol.ts';
import { messageDelivery } from '../src/room/delivery.ts';
import { discussionMessages } from '../src/room/exchange.ts';
import { foldRoom } from '../src/room/fold.ts';
import { foldPeople } from '../src/room/presence.ts';
import { readView } from '../src/room/read.ts';
import { routes } from '../src/room/routing.ts';
import * as rules from '../src/room/rules.verified.ts';
import { decide } from '../src/room/transition.ts';
import { viewOf } from '../src/room/view.ts';
import * as vocabulary from '../src/rules.verified.ts';
import { inProcessTransport, runningRoom } from '../src/transport.ts';
import type { Message } from '../src/types.ts';
import { fakeClock } from './support/clock.ts';
import { roomName } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { memory } from './support/storage.ts';

vi.mock('../src/room/rules.verified.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/room/rules.verified.ts')>();
	return {
		...actual,
		mayEnd: vi.fn(actual.mayEnd),
		permits: vi.fn(actual.permits),
		leaseExpiry: vi.fn(actual.leaseExpiry),
		acknowledged: vi.fn(actual.acknowledged),
		speechFreshness: vi.fn(actual.speechFreshness),
		admitsClose: vi.fn(actual.admitsClose),
		survivesCancellation: vi.fn(actual.survivesCancellation),
		applyChange: vi.fn(actual.applyChange),
		cancelHold: vi.fn(actual.cancelHold),
		wakeAnswered: vi.fn(actual.wakeAnswered),
		mayClose: vi.fn(actual.mayClose),
		forgets: vi.fn(actual.forgets),
		readyToSend: vi.fn(actual.readyToSend),
		endingOf: vi.fn(actual.endingOf),
		woken: vi.fn(actual.woken),
		steers: vi.fn(actual.steers),
		foldPresence: vi.fn(actual.foldPresence),
		activationGrant: vi.fn(actual.activationGrant),
		nextActivationId: vi.fn(actual.nextActivationId),
		summaryVerdict: vi.fn(actual.summaryVerdict),
		foldRoster: vi.fn(actual.foldRoster),
		reserveOf: vi.fn(actual.reserveOf),
		openingQuestion: vi.fn(actual.openingQuestion),
		lastOf: vi.fn(actual.lastOf),
		discussion: vi.fn(actual.discussion),
		messagesSince: vi.fn(actual.messagesSince),
		exchangeContaining: vi.fn(actual.exchangeContaining),
		admitsLease: vi.fn(actual.admitsLease),
		presenceOutcome: vi.fn(actual.presenceOutcome),
		hostMembership: vi.fn(actual.hostMembership),
		membershipOutcome: vi.fn(actual.membershipOutcome),
		addressOutcome: vi.fn(actual.addressOutcome),
		distinct: vi.fn(actual.distinct),
		commitAuthority: vi.fn(actual.commitAuthority),
		stampedSummary: vi.fn(actual.stampedSummary),
		addressesOwner: vi.fn(actual.addressesOwner),
		deliveryMatches: vi.fn(actual.deliveryMatches),
		contributionMatches: vi.fn(actual.contributionMatches),
	};
});

vi.mock('../src/rules.verified.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/rules.verified.ts')>();
	return {
		...actual,
		rangeWellFormed: vi.fn(actual.rangeWellFormed),
		positiveBounded: vi.fn(actual.positiveBounded),
		coversSeq: vi.fn(actual.coversSeq),
	};
});

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };
const id = 'message:3:product:1';

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		agents: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
		available: [],
		at,
	},
};
const person: Entry = {
	kind: 'message',
	seq: 2,
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Person.' },
};
const question: Entry = {
	kind: 'message',
	seq: 3,
	body: { kind: 'said', at, from: 'priya', text: 'Question.', wakes: ['product'] },
};
const running: Entry = {
	kind: 'lease',
	seq: 4,
	body: { id, phase: 'running', expiresAt: now + 60_000, at, readThrough: 3 },
};
const cancel: Entry = { kind: 'cancel', seq: 4, body: { at } };

const asked = () => foldRoom([composition, person, question], options);
const claimed = () => foldRoom([composition, person, question, running], options);

describe('the room runs the verified rules', () => {
	it('ends a lease only when mayEnd says so', () => {
		const end = { type: 'end', id, reason: 'revoked', readThrough: 0 } as const;
		vi.mocked(rules.mayEnd).mockReturnValueOnce(false);
		expect(decide(claimed(), end, now)).toEqual({ event: undefined });
		expect(decide(claimed(), end, now)).toMatchObject({
			event: { kind: 'lease', body: { phase: 'ended', reason: 'revoked' } },
		});
	});

	it('permits an intent only when permits says so', () => {
		const commit: CommitRequest = {
			activation: id,
			key: 'answer',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough: 3,
		};
		vi.mocked(rules.permits).mockReturnValueOnce(false);
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/cannot submit/) },
		});
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said', text: 'Answer.' } },
		});
	});

	it('writes the expiry leaseExpiry answers', () => {
		vi.mocked(rules.leaseExpiry).mockReturnValueOnce(12_345);
		expect(
			decide(asked(), { type: 'claim', id, expiry: 60_000, deadline: 600_000 }, now),
		).toMatchObject({ event: { kind: 'lease', body: { phase: 'running', expiresAt: 12_345 } } });
	});

	it('writes the read position acknowledged answers', () => {
		vi.mocked(rules.acknowledged).mockReturnValueOnce(3);
		expect(
			decide(
				claimed(),
				{ type: 'renew', id, expiry: 60_000, deadline: 600_000, readThrough: 0 },
				now,
			),
		).toMatchObject({ event: { kind: 'lease', body: { readThrough: 3 } } });
	});

	it('refuses or admits speech as speechFreshness answers', () => {
		const commit = (readThrough: number): CommitRequest => ({
			activation: id,
			key: 'answer',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough,
		});
		vi.mocked(rules.speechFreshness).mockReturnValueOnce('missed');
		expect(decide(claimed(), { type: 'commit', commit: commit(3) }, now)).toMatchObject({
			refusal: { category: 'missed' },
		});
		vi.mocked(rules.speechFreshness).mockReturnValueOnce('fresh');
		expect(decide(claimed(), { type: 'commit', commit: commit(2) }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said' } },
		});
	});

	it('writes a close only when admitsClose says so', () => {
		const close = { owner: 'priya', from: 3, through: 3, at };
		vi.mocked(rules.admitsClose).mockReturnValueOnce(false);
		expect(decide(asked(), { type: 'close', close }, now)).toEqual({ event: undefined });
		vi.mocked(rules.admitsClose).mockReturnValueOnce(true);
		expect(decide(asked(), { type: 'close', close: { ...close, through: 9 } }, now)).toMatchObject({
			event: { kind: 'close', body: { through: 9 } },
		});
	});

	it('holds the lease applyChange answers', () => {
		const sentinel = {
			id,
			phase: 'ended',
			reason: 'failed',
			at,
			claimedAt: at,
			since: 1,
			readThrough: 0,
			until: 4,
		} as const;
		vi.mocked(rules.applyChange).mockReturnValueOnce(sentinel);
		expect(claimed().leases.get(id)).toEqual(sentinel);
		expect(claimed().leases.get(id)).toMatchObject({ phase: 'running' });
	});

	it('ends a lease at a cancellation only as cancelHold answers', () => {
		const state = () =>
			foldRoom([composition, person, question, running, { ...cancel, seq: 5 }], options);
		vi.mocked(rules.cancelHold).mockImplementationOnce((hold) => hold);
		expect(state().leases.get(id)).toMatchObject({ phase: 'running' });
		expect(state().leases.get(id)).toMatchObject({
			phase: 'ended',
			reason: 'revoked',
			cancelled: true,
		});
	});

	it('owes a wake only when wakeAnswered says nobody answered it', () => {
		vi.mocked(rules.wakeAnswered).mockReturnValueOnce(true);
		expect(asked().pending).toEqual([]);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
	});

	it('closes, forgets, sends, and ends leases as the pass rules answer', () => {
		const reconcile = (state: ReturnType<typeof asked>, sent: Map<string, number> = new Map()) =>
			decide(
				state,
				{ type: 'reconcile', options: { resend: 5_000, attempts: 3, sent, stopped: false } },
				now,
			);
		// A quiet room with an open exchange and no work closes it, unless mayClose refuses.
		const quiet = foldRoom(
			[composition, person, { ...question, body: { ...question.body, wakes: [] } }],
			options,
		);
		vi.mocked(rules.mayClose).mockReturnValueOnce(false);
		expect(reconcile(quiet).events).toEqual([]);
		expect(reconcile(quiet).events).toMatchObject([{ kind: 'close' }]);
		// The forget list is what forgets answers.
		vi.mocked(rules.forgets).mockReturnValueOnce(['x']);
		expect(reconcile(asked()).effects.forget).toEqual(['x']);
		// A due wake is sent only when readyToSend says so.
		vi.mocked(rules.readyToSend).mockReturnValueOnce(false);
		expect(reconcile(asked()).effects.sends).toEqual([]);
		expect(reconcile(asked()).effects.sends).toEqual([{ id, seat: 'product' }]);
		// A running lease ends the way endingOf answers.
		vi.mocked(rules.endingOf).mockReturnValueOnce('expired');
		expect(reconcile(claimed()).events).toMatchObject([
			{ kind: 'lease', body: { id, phase: 'ended', reason: 'expired' } },
		]);
		expect(reconcile(claimed()).events).toEqual([]);
	});

	it('keeps a pending wake only when survivesCancellation says so', () => {
		vi.mocked(rules.survivesCancellation).mockReturnValue(false);
		expect(asked().pending).toEqual([]);
		vi.mocked(rules.survivesCancellation).mockReset();
		vi.mocked(rules.survivesCancellation).mockImplementation(
			(position, cancelledAt) => cancelledAt === undefined || position >= cancelledAt,
		);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
		expect(foldRoom([composition, person, question, cancel], options).pending).toEqual([]);
	});

	it('wakes the seats woken names', () => {
		const said: Message = { kind: 'said', seq: 3, at, from: 'priya', text: 'Question.' };
		vi.mocked(rules.woken).mockReturnValueOnce(['nobody']);
		expect(routes(said, asked(), new Map())).toEqual(['nobody']);
		expect(routes(said, asked(), new Map())).toEqual(['product']);
	});

	it('steers a lease only when steers says so', () => {
		const later: Message = { kind: 'said', seq: 5, at, from: 'priya', text: 'More.', wakes: [] };
		const leases = claimed().leases;
		vi.mocked(rules.steers).mockReturnValueOnce(false);
		expect(messageDelivery(later, leases).steers).toEqual([]);
		expect(messageDelivery(later, leases).steers).toEqual([{ seat: 'product', activation: id }]);
	});

	it('knows the people foldPresence answers', () => {
		const ghost = {
			name: 'ghost',
			identity: '',
			presence: 'absent',
			since: undefined,
			changedAt: undefined,
			preferences: undefined,
		} as const;
		const arrival: Message = {
			kind: 'arrived',
			seq: 2,
			at,
			from: 'priya',
			subject: 'priya',
			identity: 'Person.',
		};
		vi.mocked(rules.foldPresence).mockReturnValueOnce(new Map([['ghost', ghost]]));
		expect([...foldPeople([arrival]).keys()]).toEqual(['ghost']);
		expect([...foldPeople([arrival]).keys()]).toEqual(['priya']);
	});

	it('grants an activation only what activationGrant answers', () => {
		const claim = { type: 'claim', id, expiry: 60_000, deadline: 600_000 } as const;
		vi.mocked(rules.activationGrant).mockReturnValueOnce(undefined);
		expect(decide(asked(), claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		expect(decide(asked(), claim, now)).toMatchObject({ event: { kind: 'lease' } });
	});

	it('numbers the next attempt as nextActivationId answers', () => {
		vi.mocked(rules.nextActivationId).mockReturnValueOnce({
			source: 'message',
			position: 3,
			seat: 'product',
			attempt: 7,
		});
		expect(asked().due.map((owed) => owed.id)).toEqual(['message:3:product:7']);
		expect(asked().due.map((owed) => owed.id)).toEqual([id]);
	});

	it('refuses a range only when rangeWellFormed says so', () => {
		const close = { owner: 'priya', from: 3, through: 3, at };
		vi.mocked(vocabulary.rangeWellFormed).mockReturnValueOnce(false);
		expect(() => validateRoomBody('close', close)).toThrow(/range/);
		expect(validateRoomBody('close', close)).toBe(true);
	});

	it('bounds a position as positiveBounded answers', () => {
		const fields = { source: 'message', position: 3, seat: 'product', attempt: 1 } as const;
		vi.mocked(vocabulary.positiveBounded).mockReturnValueOnce(false);
		expect(() => encodeActivationId(fields)).toThrow(/position/);
		expect(encodeActivationId(fields)).toBe(id);
	});

	it('folds the roster, the reserve, the exchange, and the last seq as the rules answer', () => {
		const ghost = { name: 'ghost', identity: 'Ghost.', attention: 'broadcast' } as const;
		vi.mocked(rules.foldRoster).mockReturnValueOnce([ghost]);
		expect(asked().roster).toEqual([ghost]);
		vi.mocked(rules.reserveOf).mockReturnValueOnce([ghost]);
		expect(asked().reserve).toEqual([ghost]);
		expect(asked().reserve).toEqual([]);
		vi.mocked(rules.openingQuestion).mockReturnValueOnce(undefined);
		expect(asked().exchange).toBeUndefined();
		expect(asked().exchange).toMatchObject({ owner: 'priya', from: 3 });
		// The fold asks twice: the closes' end, then the record's.
		vi.mocked(rules.lastOf).mockReturnValueOnce(0).mockReturnValueOnce(99);
		expect(asked().lastSeq).toBe(99);
		expect(asked().lastSeq).toBe(3);
	});

	it('owes a summary only when summaryVerdict says the close owes one', () => {
		const named: Entry = {
			...composition,
			body: { ...composition.body, summary: 'product' },
		};
		const close: Entry = {
			kind: 'close',
			seq: 4,
			body: { owner: 'priya', from: 3, through: 3, at, summary: 'product' },
		};
		const closed = () => foldRoom([named, person, question, close], options);
		vi.mocked(rules.summaryVerdict).mockReturnValueOnce({ status: 'failed' });
		expect(closed().owed).toEqual([]);
		expect(closed().owed).toMatchObject([{ writer: 'product', through: 3 }]);
	});

	it('reads the discussion, the messages since a cursor, and a summary view as the rules answer', () => {
		const state = asked();
		vi.mocked(rules.discussion).mockReturnValueOnce([]);
		expect(discussionMessages(state.messages, 1, 9)).toEqual([]);
		expect(discussionMessages(state.messages, 1, 9)).toHaveLength(2);
		vi.mocked(rules.messagesSince).mockReturnValueOnce([]);
		expect(readView('r', state, now, 3, { since: 0 }).messages).toEqual([]);
		expect(readView('r', state, now, 3, { since: 0 }).messages).toHaveLength(2);
		const facts = { name: 'product', now, state, live: new Map(), unseen: () => 0 };
		const spec = {
			id: 'closed:3:product:1',
			seat: 'product',
			attempt: 1,
			purpose: { kind: 'summarize', exchange: 3, person: 'priya', through: 3 },
		} as const;
		vi.mocked(vocabulary.coversSeq).mockReturnValue(false);
		expect(viewOf(spec, facts).context.messages).toEqual([]);
		vi.mocked(vocabulary.coversSeq).mockReset();
		vi.mocked(vocabulary.coversSeq).mockImplementation(
			(from, through, seq) => from <= seq && seq <= through,
		);
		expect(viewOf(spec, facts).context.messages).toHaveLength(1);
	});

	it('hands a delivery to the exchange exchangeContaining names', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
			stream: scripted(() => quiet()),
		});
		const room = await startRoom({
			name: roomName('binding'),
			runtime,
			agents: [
				defineAgent({
					name: 'product',
					identity: 'Product.',
					instructions: 'Answer.',
					model: 'scripted/product',
				}),
			],
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(defineHuman({ name: 'priya', identity: 'Person.' }));
			vi.mocked(rules.exchangeContaining).mockReturnValueOnce({ kind: 'outside' });
			await expect(visit.send({ text: 'Question.' })).rejects.toThrow(/does not belong/);
			expect((await visit.send({ text: 'Again.' })).owner).toBe('priya');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('admits a claim or a renewal as admitsLease answers', () => {
		const renew = { type: 'renew', id, expiry: 60_000, deadline: 600_000 } as const;
		vi.mocked(rules.admitsLease).mockReturnValueOnce('granted');
		expect(decide(asked(), renew, now)).toMatchObject({ event: { kind: 'lease' } });
		expect(decide(asked(), renew, now)).toMatchObject({ refusal: { category: 'stale' } });
	});

	it('writes, skips, or refuses a presence change as the rules answer', () => {
		const arrival = {
			type: 'presence',
			change: { kind: 'arrived', subject: 'sam', identity: 'Engineer.', from: 'sam' },
			route: false,
		} as const;
		vi.mocked(rules.presenceOutcome).mockReturnValueOnce('refused');
		expect(decide(asked(), arrival, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), arrival, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'arrived', subject: 'sam' } },
		});
		const unseat = {
			type: 'presence',
			change: { kind: 'unseated', subject: 'product' },
			route: false,
		} as const;
		vi.mocked(rules.hostMembership).mockReturnValueOnce(false);
		expect(decide(asked(), unseat, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), unseat, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'unseated', subject: 'product' } },
		});
	});

	it('seats and unseats as membershipOutcome answers', () => {
		const commit = (intent: CommitRequest['intent']): CommitRequest => ({
			activation: id,
			key: 'membership',
			intent,
			readThrough: 3,
		});
		vi.mocked(rules.membershipOutcome).mockReturnValueOnce('refused');
		expect(
			decide(
				claimed(),
				{ type: 'commit', commit: commit({ kind: 'unseated', name: 'product' }) },
				now,
			),
		).toMatchObject({ refusal: { category: 'refused' } });
		expect(
			decide(
				claimed(),
				{ type: 'commit', commit: commit({ kind: 'unseated', name: 'product' }) },
				now,
			),
		).toMatchObject({ event: { kind: 'message', body: { kind: 'unseated' } } });
	});

	it('addresses a message as addressOutcome answers', () => {
		vi.mocked(rules.addressOutcome).mockReturnValueOnce('unknown');
		const deliver = { type: 'deliver', from: 'priya', text: 'Hello.' } as const;
		expect(decide(asked(), deliver, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), deliver, now)).toMatchObject({ event: { kind: 'message' } });
		const commit: CommitRequest = {
			activation: id,
			key: 'say',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough: 3,
		};
		vi.mocked(rules.addressOutcome).mockReturnValueOnce('self');
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/yourself/) },
		});
	});

	it('admits a composition only when distinct says so', () => {
		const compose = { type: 'compose', composition: composition.body } as const;
		vi.mocked(rules.distinct).mockReturnValueOnce(false);
		expect(decide(asked(), compose, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), compose, now)).toMatchObject({ event: { kind: 'composition' } });
	});

	it('lets a commit through only as commitAuthority answers', () => {
		const commit: CommitRequest = {
			activation: id,
			key: 'say',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough: 3,
		};
		vi.mocked(rules.commitAuthority).mockReturnValueOnce('stale');
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { category: 'stale' },
		});
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			event: { kind: 'message' },
		});
	});

	it('stamps a closing commit as the rules answer', () => {
		const named: Entry = { ...composition, body: { ...composition.body, summary: 'product' } };
		const close: Entry = {
			kind: 'close',
			seq: 4,
			body: { owner: 'priya', from: 3, through: 3, at, summary: 'product' },
		};
		const drafting: Entry = {
			kind: 'lease',
			seq: 5,
			body: {
				id: 'closed:3:product:1',
				phase: 'running',
				expiresAt: now + 60_000,
				at,
				readThrough: 4,
			},
		};
		const state = foldRoom([named, person, question, close, drafting], options);
		const commit: CommitRequest = {
			activation: 'closed:3:product:1',
			key: 'summary',
			intent: { kind: 'said', text: 'What happened.' },
			readThrough: 4,
		};
		vi.mocked(rules.addressesOwner).mockReturnValueOnce(false);
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/exchange owner/) },
		});
		vi.mocked(rules.stampedSummary).mockReturnValueOnce({
			to: 'ghost',
			covers: { from: 1, through: 2 },
		});
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			event: { body: { kind: 'summary', to: 'ghost', covers: { from: 1, through: 2 } } },
		});
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			event: { body: { kind: 'summary', to: 'priya', covers: { from: 3, through: 3 } } },
		});
	});

	it('answers a keyed retry as the match rules answer', async () => {
		const opened = await memory.open();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: fakeClock(),
			transport: inProcessTransport(),
			stream: scripted(() => quiet()),
		});
		const room = await startRoom({
			name: roomName('binding-retry'),
			runtime,
			agents: [
				defineAgent({
					name: 'product',
					identity: 'Product.',
					instructions: 'Answer.',
					model: 'scripted/product',
				}),
			],
			streamFn: scripted(() => quiet()),
		});
		try {
			const visit = await room.visit(defineHuman({ name: 'priya', identity: 'Person.' }));
			const first = await visit.send({ key: 'k', text: 'Question.' });
			vi.mocked(rules.deliveryMatches).mockReturnValueOnce(false);
			await expect(visit.send({ key: 'k', text: 'Question.' })).rejects.toThrow(
				/different room operation/,
			);
			expect((await visit.send({ key: 'k', text: 'Question.' })).from).toBe(first.from);
			const peer = runningRoom(runtime, room.name);
			if (peer === undefined) throw new Error('The room is absent.');
			const activation = `message:${first.from}:product:1`;
			expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
			const request: CommitRequest = {
				activation,
				key: 'c',
				readThrough: first.from,
				intent: { kind: 'said', text: 'Answer.' },
			};
			expect(await peer.commit(request)).toMatchObject({ committed: { text: 'Answer.' } });
			vi.mocked(rules.contributionMatches).mockReturnValueOnce(false);
			expect(await peer.commit(request)).toMatchObject({
				refused: expect.stringMatching(/different room operation/),
			});
			expect(await peer.commit(request)).toMatchObject({ committed: { text: 'Answer.' } });
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
});
