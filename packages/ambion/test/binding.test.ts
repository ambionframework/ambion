/**
 * The binding between the room's verified rules and the code that runs
 * them. A proof is about a rule's body; it reaches the room only when a
 * decision runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the decision
 * follows it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
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
import * as record from '../src/room/rules.record.verified.ts';
import * as roster from '../src/room/rules.roster.verified.ts';
import * as rules from '../src/room/rules.verified.ts';
import { decide } from '../src/room/transition.ts';
import { viewOf } from '../src/room/view.ts';
import * as vocabulary from '../src/rules.verified.ts';
import { inProcessTransport, runningRoom } from '../src/transport.ts';
import type { Message } from '../src/types.ts';
import { bindings } from './support/binding.ts';
import { fakeClock } from './support/clock.ts';
import { roomName } from './support/room.ts';
import { quiet, scripted } from './support/scripted.ts';
import { memory } from './support/storage.ts';

vi.mock('../src/room/rules.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/room/rules.verified.ts')>());
});
vi.mock('../src/room/rules.roster.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/room/rules.roster.verified.ts')>());
});
vi.mock('../src/room/rules.record.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/room/rules.record.verified.ts')>());
});
vi.mock('../src/rules.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/rules.verified.ts')>());
});

const bind = bindings({ rules, roster, record, vocabulary });
afterAll(() => expect(bind.unbound()).toEqual([]));

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
const reconcile = (state: ReturnType<typeof asked>, sent: Map<string, number> = new Map()) =>
	decide(
		state,
		{ type: 'reconcile', options: { resend: 5_000, attempts: 3, sent, stopped: false } },
		now,
	);
/** The composition names a summary writer, and one exchange closed at the question. */
const writerNamed: Entry = { ...composition, body: { ...composition.body, summary: 'product' } };
const closed3: Entry = {
	kind: 'close',
	seq: 4,
	body: { owner: 'priya', from: 3, through: 3, at, summary: 'product' },
};
const quietQuestion: Entry = { ...question, body: { ...question.body, wakes: [] } };
const claimed = () => foldRoom([composition, person, question, running], options);

describe('the room runs the verified rules', () => {
	it('ends a lease only when mayEnd says so', () => {
		const end = { type: 'end', id, reason: 'revoked', readThrough: 0 } as const;
		bind.once(rules.mayEnd, false);
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
		bind.once(rules.permits, false);
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/cannot submit/) },
		});
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said', text: 'Answer.' } },
		});
	});

	it('writes the expiry leaseExpiry answers', () => {
		bind.once(rules.leaseExpiry, 12_345);
		expect(
			decide(asked(), { type: 'claim', id, expiry: 60_000, deadline: 600_000 }, now),
		).toMatchObject({ event: { kind: 'lease', body: { phase: 'running', expiresAt: 12_345 } } });
	});

	it('writes the read position acknowledged answers', () => {
		bind.once(rules.acknowledged, 3);
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
		bind.once(rules.speechFreshness, 'missed');
		expect(decide(claimed(), { type: 'commit', commit: commit(3) }, now)).toMatchObject({
			refusal: { category: 'missed' },
		});
		bind.once(rules.speechFreshness, 'fresh');
		expect(decide(claimed(), { type: 'commit', commit: commit(2) }, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'said' } },
		});
	});

	it('writes a close only when admitsClose says so', () => {
		const close = { owner: 'priya', from: 3, through: 3, at };
		bind.once(rules.admitsClose, false);
		expect(decide(asked(), { type: 'close', close }, now)).toEqual({ event: undefined });
		bind.once(rules.admitsClose, true);
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
		bind.once(rules.applyChange, sentinel);
		expect(claimed().leases.get(id)).toEqual(sentinel);
		expect(claimed().leases.get(id)).toMatchObject({ phase: 'running' });
	});

	it('ends a lease at a cancellation only as cancelHold answers', () => {
		const state = () =>
			foldRoom([composition, person, question, running, { ...cancel, seq: 5 }], options);
		bind.onceWith(rules.cancelHold, (hold) => hold);
		expect(state().leases.get(id)).toMatchObject({ phase: 'running' });
		expect(state().leases.get(id)).toMatchObject({
			phase: 'ended',
			reason: 'revoked',
			cancelled: true,
		});
	});

	it('owes a wake only when wakeAnswered says nobody answered it', () => {
		bind.once(rules.wakeAnswered, true);
		expect(asked().pending).toEqual([]);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
	});

	it('closes, forgets, sends, and ends leases as the pass rules answer', () => {
		// A quiet room with an open exchange and no work closes it, unless mayClose refuses.
		const quiet = foldRoom(
			[composition, person, { ...question, body: { ...question.body, wakes: [] } }],
			options,
		);
		bind.once(rules.mayClose, false);
		expect(reconcile(quiet).events).toEqual([]);
		expect(reconcile(quiet).events).toMatchObject([{ kind: 'close' }]);
		// The forget list is what forgets answers.
		bind.once(rules.forgets, ['x']);
		expect(reconcile(asked()).effects.forget).toEqual(['x']);
		// A due wake is sent only when readyToSend says so.
		bind.once(rules.readyToSend, false);
		expect(reconcile(asked()).effects.sends).toEqual([]);
		expect(reconcile(asked()).effects.sends).toEqual([{ id, seat: 'product' }]);
		// A running lease ends the way endingOf answers.
		bind.once(rules.endingOf, 'expired');
		expect(reconcile(claimed()).events).toMatchObject([
			{ kind: 'lease', body: { id, phase: 'ended', reason: 'expired' } },
		]);
		expect(reconcile(claimed()).events).toEqual([]);
	});

	it('keeps a pending wake only when survivesCancellation says so', () => {
		bind.always(rules.survivesCancellation, () => false);
		expect(asked().pending).toEqual([]);
		bind.restore(rules.survivesCancellation);
		expect(asked().pending.map((wake) => wake.id)).toEqual([id]);
		expect(foldRoom([composition, person, question, cancel], options).pending).toEqual([]);
	});

	it('wakes the seats woken names', () => {
		const said: Message = { kind: 'said', seq: 3, at, from: 'priya', text: 'Question.' };
		bind.once(roster.woken, ['nobody']);
		expect(routes(said, asked(), new Map())).toEqual(['nobody']);
		expect(routes(said, asked(), new Map())).toEqual(['product']);
	});

	it('steers a lease only when steers says so', () => {
		const later: Message = { kind: 'said', seq: 5, at, from: 'priya', text: 'More.', wakes: [] };
		const leases = claimed().leases;
		bind.once(roster.steers, false);
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
		bind.once(roster.foldPresence, new Map([['ghost', ghost]]));
		expect([...foldPeople([arrival]).keys()]).toEqual(['ghost']);
		expect([...foldPeople([arrival]).keys()]).toEqual(['priya']);
	});

	it('grants an activation only what activationGrant answers', () => {
		const claim = { type: 'claim', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.activationGrant, undefined);
		expect(decide(asked(), claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		expect(decide(asked(), claim, now)).toMatchObject({ event: { kind: 'lease' } });
	});

	it('numbers the next attempt as nextActivationId answers', () => {
		bind.once(rules.nextActivationId, {
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
		bind.once(vocabulary.rangeWellFormed, false);
		expect(() => validateRoomBody('close', close)).toThrow(/range/);
		expect(validateRoomBody('close', close)).toBe(true);
	});

	it('bounds a position as positiveBounded answers', () => {
		const fields = { source: 'message', position: 3, seat: 'product', attempt: 1 } as const;
		bind.once(vocabulary.positiveBounded, false);
		expect(() => encodeActivationId(fields)).toThrow(/position/);
		expect(encodeActivationId(fields)).toBe(id);
	});

	it('folds the roster, the reserve, the exchange, and the last seq as the rules answer', () => {
		const ghost = { name: 'ghost', identity: 'Ghost.', attention: 'broadcast' } as const;
		bind.once(roster.foldRoster, [ghost]);
		expect(asked().roster).toEqual([ghost]);
		bind.once(roster.reserveOf, [ghost]);
		expect(asked().reserve).toEqual([ghost]);
		expect(asked().reserve).toEqual([]);
		bind.once(record.openingQuestion, undefined);
		expect(asked().exchange).toBeUndefined();
		expect(asked().exchange).toMatchObject({ owner: 'priya', from: 3 });
		// The fold asks twice: the closes' end, then the record's.
		bind.once(record.lastOf, 0);
		bind.once(record.lastOf, 99);
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
		bind.once(rules.summaryVerdict, { status: 'failed' });
		expect(closed().owed).toEqual([]);
		expect(closed().owed).toMatchObject([{ writer: 'product', through: 3 }]);
	});

	it('reads the discussion, the messages since a cursor, and a summary view as the rules answer', () => {
		const state = asked();
		bind.once(record.discussion, []);
		expect(discussionMessages(state.messages, 1, 9)).toEqual([]);
		expect(discussionMessages(state.messages, 1, 9)).toHaveLength(2);
		bind.once(record.messagesSince, []);
		expect(readView('r', state, now, 3, { since: 0 }).messages).toEqual([]);
		expect(readView('r', state, now, 3, { since: 0 }).messages).toHaveLength(2);
		const facts = { name: 'product', now, state, live: new Map(), unseen: () => 0 };
		const spec = {
			id: 'closed:3:product:1',
			seat: 'product',
			attempt: 1,
			purpose: { kind: 'summarize', exchange: 3, person: 'priya', through: 3 },
		} as const;
		bind.always(vocabulary.coversSeq, () => false);
		expect(viewOf(spec, facts).context.messages).toEqual([]);
		bind.restore(vocabulary.coversSeq);
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
			bind.once(rules.exchangeContaining, { kind: 'outside' });
			await expect(visit.send({ text: 'Question.' })).rejects.toThrow(/does not belong/);
			expect((await visit.send({ text: 'Again.' })).owner).toBe('priya');
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});

	it('admits a claim or a renewal as admitsLease answers', () => {
		const renew = { type: 'renew', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.admitsLease, 'granted');
		expect(decide(asked(), renew, now)).toMatchObject({ event: { kind: 'lease' } });
		expect(decide(asked(), renew, now)).toMatchObject({ refusal: { category: 'stale' } });
	});

	it('writes, skips, or refuses a presence change as the rules answer', () => {
		const arrival = {
			type: 'presence',
			change: { kind: 'arrived', subject: 'sam', identity: 'Engineer.', from: 'sam' },
			route: false,
		} as const;
		bind.once(rules.presenceOutcome, 'refused');
		expect(decide(asked(), arrival, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), arrival, now)).toMatchObject({
			event: { kind: 'message', body: { kind: 'arrived', subject: 'sam' } },
		});
		const unseat = {
			type: 'presence',
			change: { kind: 'unseated', subject: 'product' },
			route: false,
		} as const;
		bind.once(rules.hostMembership, false);
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
		bind.once(rules.membershipOutcome, 'refused');
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
		bind.once(roster.addressOutcome, 'unknown');
		const deliver = { type: 'deliver', from: 'priya', text: 'Hello.' } as const;
		expect(decide(asked(), deliver, now)).toMatchObject({ refusal: { category: 'refused' } });
		expect(decide(asked(), deliver, now)).toMatchObject({ event: { kind: 'message' } });
		const commit: CommitRequest = {
			activation: id,
			key: 'say',
			intent: { kind: 'said', text: 'Answer.' },
			readThrough: 3,
		};
		bind.once(roster.addressOutcome, 'self');
		expect(decide(claimed(), { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/yourself/) },
		});
	});

	it('admits a composition only when distinct says so', () => {
		const compose = { type: 'compose', composition: composition.body } as const;
		bind.once(rules.distinct, false);
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
		bind.once(rules.commitAuthority, 'stale');
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
		bind.once(rules.addressesOwner, false);
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/exchange owner/) },
		});
		bind.once(rules.stampedSummary, {
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
			bind.once(record.deliveryMatches, false);
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
			bind.once(record.contributionMatches, false);
			expect(await peer.commit(request)).toMatchObject({
				refused: expect.stringMatching(/different room operation/),
			});
			expect(await peer.commit(request)).toMatchObject({ committed: { text: 'Answer.' } });
			// A close the decision refuses asks closeMoved whether the exchange moved; a
			// moved exchange is planned again, and the next pass closes it.
			bind.once(rules.admitsClose, false);
			bind.once(rules.closeMoved, true);
			await peer.lease({ activation, operation: 'release', reason: 'released', readThrough: 4 });
			await first.waitForClose();
			expect(vi.mocked(rules.closeMoved).mock.calls.length).toBeGreaterThan(0);
		} finally {
			await room.stop();
			await opened.dispose();
		}
	});
	it('covers, counts, and schedules a retry as the lease rules answer', () => {
		const failed: Entry = {
			kind: 'lease',
			seq: 5,
			body: { id, phase: 'ended', reason: 'failed', at, readThrough: 0 },
		};
		const failedOnce = () => foldRoom([composition, person, question, running, failed], options);
		// A lease that covers nothing answers nothing, so the wake is owed again.
		bind.once(rules.coversAttempt, false);
		expect(claimed().pending.map((wake) => wake.id)).toEqual([id]);
		expect(claimed().pending).toEqual([]);
		bind.once(rules.countsAgainst, false);
		expect(failedOnce().pending[0]?.unsuccessfulAttempts).toBe(0);
		expect(failedOnce().pending[0]?.unsuccessfulAttempts).toBe(1);
		bind.once(rules.latest, 12_345);
		expect(failedOnce().pending[0]?.notBefore).toBe(12_345);
		bind.once(rules.schedule, { attempt: 2, notBefore: 777 });
		expect(failedOnce().pending[0]?.notBefore).toBe(777);
	});

	it('counts a draft that came to nothing as cameToNothing answers', () => {
		const draftFailed: Entry = {
			kind: 'lease',
			seq: 5,
			body: { id: 'closed:3:product:1', phase: 'ended', reason: 'failed', at, readThrough: 4 },
		};
		const closed = () => foldRoom([writerNamed, person, question, closed3, draftFailed], options);
		bind.once(rules.cameToNothing, false);
		expect(closed().owed[0]?.unsuccessfulAttempts).toBe(0);
		expect(closed().owed[0]?.unsuccessfulAttempts).toBe(1);
	});

	it('ends, renews, and acknowledges as the clock and record rules answer', () => {
		const state = claimed();
		const renew = { type: 'renew', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.isLive, false);
		expect(decide(state, renew, now)).toMatchObject({ refusal: { category: 'stale' } });
		const expire = { type: 'end', id, reason: 'expired', readThrough: 0 } as const;
		bind.once(rules.isExpired, true);
		expect(decide(state, expire, now)).toMatchObject({ event: { body: { reason: 'expired' } } });
		expect(decide(state, expire, now)).toEqual({ event: undefined });
		const late = { ...expire, reason: 'revoked', readThrough: 99 } as const;
		bind.once(rules.onRecord, true);
		expect(decide(state, late, now)).toMatchObject({ event: { kind: 'lease' } });
		expect(decide(state, late, now)).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('grants and revokes a stale activation as removedAfter, wellFormed, and staleLease answer', () => {
		const state = asked();
		const claim = { type: 'claim', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.removedAfter, true);
		expect(decide(state, claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		bind.once(rules.wellFormed, false);
		expect(decide(state, claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		expect(decide(state, claim, now)).toMatchObject({ event: { kind: 'lease' } });
		const held = claimed();
		bind.once(rules.staleLease, true);
		expect(reconcile(held).events).toMatchObject([{ kind: 'lease', body: { reason: 'revoked' } }]);
		expect(reconcile(held).events).toEqual([]);
	});

	it('publishes a summary only when coversExchange says it covers', () => {
		const published: Entry = {
			kind: 'message',
			seq: 5,
			body: {
				kind: 'summary',
				at,
				from: 'product',
				to: 'priya',
				text: 'What happened.',
				covers: { from: 3, through: 3 },
				activationId: 'closed:3:product:1',
			},
		};
		const entries = [writerNamed, person, question, closed3, published];
		expect(foldRoom(entries, options).owed).toEqual([]);
		bind.once(rules.coversExchange, false);
		expect(foldRoom(entries, options).owed).toHaveLength(1);
	});

	it('grants a closing activation only for the close closeFor finds', () => {
		const state = foldRoom([writerNamed, person, question, closed3], options);
		const claim = {
			type: 'claim',
			id: 'closed:3:product:1',
			expiry: 60_000,
			deadline: 600_000,
		} as const;
		bind.once(rules.closeFor, undefined);
		expect(decide(state, claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		expect(decide(state, claim, now)).toMatchObject({ event: { kind: 'lease' } });
	});

	it('closes, names the writer, and sets the alarm as the pass rules answer', () => {
		const quiet = foldRoom([writerNamed, person, quietQuestion], options);
		expect(reconcile(quiet).events).toMatchObject([
			{ kind: 'close', body: { summary: 'product' } },
		]);
		bind.once(rules.namesWriter, false);
		expect(reconcile(quiet).events[0]?.body).not.toHaveProperty('summary');
		bind.once(roster.onRoster, false);
		expect(reconcile(quiet).events[0]?.body).not.toHaveProperty('summary');
		bind.once(rules.exchangeLive, true);
		expect(reconcile(quiet).events).toEqual([]);
		const state = asked();
		bind.once(rules.earliestAfter, now + 7);
		expect(reconcile(state).effects.alarmAt).toBe(now + 7);
		bind.once(rules.looksAgainAt, now + 9);
		expect(reconcile(state).effects.alarmAt).toBe(now + 9);
		expect(reconcile(state).effects.alarmAt).toBe(now + 5_000);
	});

	it('routes as the reach, the target, and the roster rules answer', () => {
		const state = asked();
		const said: Message = { kind: 'said', seq: 3, at, from: 'priya', text: 'Question.' };
		bind.once(roster.reachOf, 0);
		expect(routes(said, state, new Map())).toEqual([]);
		bind.once(roster.rosterFor, []);
		expect(routes(said, state, new Map())).toEqual([]);
		expect(routes(said, state, new Map())).toEqual(['product']);
		const summary: Message = {
			kind: 'summary',
			seq: 4,
			at,
			from: 'assistant',
			to: 'priya',
			text: 'S.',
			covers: { from: 3, through: 3 },
		};
		bind.once(roster.targetOf, 'product');
		expect(routes(summary, state, new Map())).toEqual(['product']);
		expect(routes(summary, state, new Map())).toEqual([]);
	});

	it('admits a delivery only when present says the author is present', () => {
		const state = asked();
		const deliver = { type: 'deliver', from: 'sam', text: 'Hello.' } as const;
		bind.once(roster.present, true);
		expect(decide(state, deliver, now)).toMatchObject({ event: { kind: 'message' } });
		expect(decide(state, deliver, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/not present/) },
		});
	});

	it('writes off an activation at the cap only when givesUp says so', () => {
		const state = asked();
		bind.once(rules.givesUp, true);
		expect(reconcile(state).events).toMatchObject([
			{ kind: 'lease', body: { reason: 'abandoned' } },
		]);
		expect(reconcile(state).events).toEqual([]);
	});
});
