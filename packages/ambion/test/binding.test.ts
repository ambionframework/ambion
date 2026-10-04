/**
 * The binding between the room's verified rules and the code that runs
 * them. A proof is about a rule's body; it reaches the room only when a
 * decision runs that body on the path the contract describes. Each case
 * replaces one rule with a sentinel answer and checks that the decision
 * follows it.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import * as seatRules from '../src/execution/rules.verified.ts';
import { runningRoom } from '../src/hosting.ts';
import { createRuntime, definePerson, startRoom } from '../src/index.ts';
import type { RoomEntry } from '../src/journal/journal.ts';
import type { CommitRequest } from '../src/protocol.ts';
import { toRoomRead } from '../src/room/read.ts';
import * as rules from '../src/room/rules.verified.ts';
import { decide } from '../src/room/transition.ts';
import { fakeClock } from '../src/testing.ts';
import { bindings } from './support/binding.ts';
import { flush } from './support/core-failure.ts';
import { owedOf, pendingOf, replayState } from './support/fold.ts';
import { closedExchange, roomName, scriptedAgent, waitForRoom } from './support/room.ts';
import { callTool, quiet, scriptedStream, seat, toolResultTexts } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';

vi.mock('../src/room/rules.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/room/rules.verified.ts')>());
});
vi.mock('../src/execution/rules.verified.ts', async (importOriginal) => {
	const { mocked } = await import('./support/binding.ts');
	return mocked(await importOriginal<typeof import('../src/execution/rules.verified.ts')>());
});
const bind = bindings({ rules, seatRules });
afterAll(() => expect(bind.unbound()).toEqual([]));

const at = '2026-01-01T09:00:00.000Z';
const now = Date.parse(at);
const options = { backoff: () => 0 };
const id = 'message:3:product:1';

const composition: RoomEntry = {
	kind: 'composition',
	seq: 1,
	body: {
		seated: [{ name: 'product', identity: 'Product.', attention: 'broadcast' }],
		reserve: [],
		at,
	},
};
const person: RoomEntry = {
	kind: 'message',
	seq: 2,
	body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Person.' },
};
const question: RoomEntry = {
	kind: 'message',
	seq: 3,
	body: { kind: 'said', at, from: 'priya', text: 'Question.', wakes: ['product'] },
};
const running: RoomEntry = {
	kind: 'lease',
	seq: 4,
	body: { id, phase: 'running', expiresAt: now + 60_000, at, readThrough: 3 },
};
const cancel: RoomEntry = { kind: 'cancel', seq: 4, body: { at } };

const asked = () => replayState([composition, person, question], options);
const reconcile = (state: ReturnType<typeof asked>, sent: Map<string, number> = new Map()) =>
	decide(
		state,
		{ type: 'reconcile', options: { resend: 5_000, attempts: 3, sent, stopped: false } },
		now,
	);
/** The composition names a summary writer, and one exchange closed at the question. */
const writerNamed: RoomEntry = {
	...composition,
	body: { ...composition.body, summaryWriter: 'product' },
};
const closed3: RoomEntry = {
	kind: 'close',
	seq: 4,
	body: { person: 'priya', from: 3, through: 3, at, summaryWriter: 'product' },
};
const quietQuestion: RoomEntry = { ...question, body: { ...question.body, wakes: [] } };
const claimed = () => replayState([composition, person, question, running], options);

describe('the room runs the verified rules', () => {
	it('ends a lease only when mayEnd says so', () => {
		const end = { type: 'end', id, reason: 'revoked', readThrough: 0 } as const;
		bind.once(rules.mayEnd, false);
		expect(decide(claimed(), end, now)).toEqual({ entry: undefined });
		expect(decide(claimed(), end, now)).toMatchObject({
			entry: { kind: 'lease', body: { phase: 'ended', reason: 'revoked' } },
		});
	});

	it('writes the expiry leaseExpiry answers', () => {
		bind.once(rules.leaseExpiry, 12_345);
		expect(
			decide(asked(), { type: 'claim', id, expiry: 60_000, deadline: 600_000 }, now),
		).toMatchObject({ entry: { kind: 'lease', body: { phase: 'running', expiresAt: 12_345 } } });
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
			entry: { kind: 'message', body: { kind: 'said' } },
		});
	});

	it('writes a close only when closeAdmission says so', () => {
		const close = { type: 'close', person: 'priya', from: 3, through: 3 } as const;
		bind.once(rules.closeAdmission, 'replan');
		expect(decide(asked(), close, now)).toEqual({ close: 'replan' });
		bind.once(rules.closeAdmission, 'obsolete');
		expect(decide(asked(), close, now)).toEqual({ close: 'obsolete' });
		bind.once(rules.closeAdmission, 'admitted');
		expect(decide(asked(), { ...close, through: 9 }, now)).toMatchObject({
			entry: { kind: 'close', body: { through: 9, at } },
		});
	});

	it('names the summary writer in a close only when owesSummary says an agent reported', () => {
		const state = () => replayState([writerNamed, person, quietQuestion], options);
		const close = { type: 'close', person: 'priya', from: 3, through: 3 } as const;
		bind.once(rules.owesSummary, true);
		expect(decide(state(), close, now)).toMatchObject({
			entry: { kind: 'close', body: { person: 'priya', summaryWriter: 'product' } },
		});
		const unowed = decide(state(), close, now);
		expect(unowed).toMatchObject({ entry: { kind: 'close', body: { person: 'priya' } } });
		expect(unowed).not.toMatchObject({ entry: { body: { summaryWriter: expect.anything() } } });
	});

	it('holds the lease applyChange answers', () => {
		const sentinel = {
			id,
			phase: 'ended',
			reason: 'failed',
			at,
			claimedAt: at,
			openedSeq: 1,
			readThrough: 0,
			until: 4,
			activation: { source: 'message', position: 3, seat: 'product', attempt: 1 },
		} as const;
		bind.once(rules.applyChange, sentinel);
		expect(claimed().leases.get(id)).toEqual(sentinel);
		expect(claimed().leases.get(id)).toMatchObject({ phase: 'running' });
	});

	it('ends a lease at a cancellation only as cancelHold answers', () => {
		const state = () =>
			replayState([composition, person, question, running, { ...cancel, seq: 5 }], options);
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
		expect(pendingOf(asked())).toEqual([]);
		expect(pendingOf(asked()).map((wake) => wake.id)).toEqual([id]);
	});

	it('ends a running lease the way endingOf answers', () => {
		bind.once(rules.endingOf, 'expired');
		expect(reconcile(claimed()).steps).toEqual([
			{ type: 'end', id, reason: 'expired', readThrough: 3 },
		]);
		expect(reconcile(claimed()).steps).toEqual([]);
	});

	it('reads an exchange outcome as exchangeOutcome answers', () => {
		bind.once(rules.exchangeOutcome, 'exhausted');
		const read = toRoomRead(
			'room',
			replayState([composition, person, question, closed3], options),
			now,
			4,
			false,
		);
		expect(read.exchanges).toMatchObject([{ status: 'closed', outcome: { kind: 'exhausted' } }]);
		expect(
			toRoomRead(
				'room',
				replayState([composition, person, question, closed3], options),
				now,
				4,
				false,
			).exchanges,
		).toMatchObject([{ outcome: { kind: 'complete' } }]);
	});

	it('owes a summary only while survivesCancellation keeps its close', () => {
		const closed = () => replayState([writerNamed, person, question, closed3], options);
		bind.always(rules.survivesCancellation, () => false);
		expect(owedOf(closed())).toEqual([]);
		bind.restore(rules.survivesCancellation);
		expect(owedOf(closed())).toMatchObject([{ seat: 'product', position: 3 }]);
	});

	it.each([
		['what activationGrant answers', () => bind.once(rules.activationGrant, undefined), asked, id],
		['when wellFormed admits its id', () => bind.once(rules.wellFormed, false), asked, id],
		[
			'for the close closeFor finds',
			() => bind.once(rules.closeFor, undefined),
			() => replayState([writerNamed, person, question, closed3], options),
			'closed:3:product:1',
		],
	])('grants an activation only %s', (_name, refuse, state, activation) => {
		const claim = { type: 'claim', id: activation, expiry: 60_000, deadline: 600_000 } as const;
		refuse();
		expect(decide(state(), claim, now)).toMatchObject({
			refusal: { reason: expect.stringMatching(/no room grant/) },
		});
		expect(decide(state(), claim, now)).toMatchObject({ entry: { kind: 'lease' } });
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

	it('derives the open exchange as openingQuestion answers', () => {
		bind.always(rules.openingQuestion, () => undefined);
		expect(asked().exchange).toBeUndefined();
		bind.restore(rules.openingQuestion);
		expect(asked().exchange).toMatchObject({ person: 'priya', from: 3 });
	});

	it('owes a summary only when summaryVerdict says the close owes one', () => {
		const closed = () => replayState([writerNamed, person, question, closed3], options);
		bind.once(rules.summaryVerdict, { kind: 'failed' });
		expect(owedOf(closed())).toEqual([]);
		expect(owedOf(closed())).toMatchObject([{ seat: 'product', position: 3 }]);
	});

	it('counts a summary attempt of a close as summarizesClose answers', () => {
		const attempted = (reason: 'failed' | 'released') => {
			const attempt = 'closed:3:product:1';
			return replayState(
				[
					writerNamed,
					person,
					quietQuestion,
					closed3,
					{
						kind: 'lease',
						seq: 5,
						body: { id: attempt, phase: 'running', expiresAt: now, at, readThrough: 0 },
					},
					{
						kind: 'lease',
						seq: 6,
						body: { id: attempt, phase: 'ended', reason, at, readThrough: 0 },
					},
				],
				options,
			);
		};
		bind.always(rules.summarizesClose, () => false);
		// No lease summarizes the close: the failed attempt is no attempt of it, and the released one stands nobody down.
		expect(owedOf(attempted('failed'))).toMatchObject([{ attempt: 1, unsuccessfulAttempts: 0 }]);
		expect(owedOf(attempted('released'))).toMatchObject([{ seat: 'product', position: 3 }]);
		bind.restore(rules.summarizesClose);
		expect(owedOf(attempted('failed'))).toMatchObject([{ attempt: 2, unsuccessfulAttempts: 1 }]);
		expect(owedOf(attempted('released'))).toEqual([]);
	});

	it('admits a claim or a renewal as admitsLease answers', () => {
		const renew = { type: 'renew', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.admitsLease, 'granted');
		expect(decide(asked(), renew, now)).toMatchObject({ entry: { kind: 'lease' } });
		expect(decide(asked(), renew, now)).toMatchObject({ refusal: { category: 'stale' } });
	});

	it('stamps a closing commit as the rules answer', () => {
		const summarizing: RoomEntry = {
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
		const state = replayState([writerNamed, person, question, closed3, summarizing], options);
		const commit: CommitRequest = {
			activation: 'closed:3:product:1',
			key: 'summary',
			intent: { kind: 'said', text: 'What happened.' },
			readThrough: 4,
		};
		bind.once(rules.stampedSummary, {
			to: 'ghost',
			covers: { from: 1, through: 2 },
		});
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			entry: { body: { kind: 'summary', to: 'ghost', covers: { from: 1, through: 2 } } },
		});
		expect(decide(state, { type: 'commit', commit }, now)).toMatchObject({
			entry: { body: { kind: 'summary', to: 'priya', covers: { from: 3, through: 3 } } },
		});
	});

	it('covers and counts a retry as the lease rules answer', () => {
		const failed: RoomEntry = {
			kind: 'lease',
			seq: 5,
			body: { id, phase: 'ended', reason: 'failed', at, readThrough: 0 },
		};
		const failedOnce = () => replayState([composition, person, question, running, failed], options);
		// A lease that covers nothing answers nothing, so the wake is owed again.
		bind.once(rules.coversAttempt, false);
		expect(pendingOf(claimed()).map((wake) => wake.id)).toEqual([id]);
		expect(pendingOf(claimed())).toEqual([]);
		bind.once(rules.countsAgainst, false);
		expect(pendingOf(failedOnce())[0]?.unsuccessfulAttempts).toBe(0);
		expect(pendingOf(failedOnce())[0]?.unsuccessfulAttempts).toBe(1);
	});

	it('ends, renews, and acknowledges as the clock and record rules answer', () => {
		const state = claimed();
		const renew = { type: 'renew', id, expiry: 60_000, deadline: 600_000 } as const;
		bind.once(rules.isLive, false);
		expect(decide(state, renew, now)).toMatchObject({ refusal: { category: 'stale' } });
		const expire = { type: 'end', id, reason: 'expired', readThrough: 0 } as const;
		bind.once(rules.isExpired, true);
		expect(decide(state, expire, now)).toMatchObject({ entry: { body: { reason: 'expired' } } });
		expect(decide(state, expire, now)).toEqual({ entry: undefined });
		const late = { ...expire, reason: 'revoked', readThrough: 99 } as const;
		bind.once(rules.onRecord, true);
		expect(decide(state, late, now)).toMatchObject({ entry: { kind: 'lease' } });
		expect(decide(state, late, now)).toMatchObject({ refusal: { category: 'refused' } });
	});

	it('publishes a summary only when coversExchange says it covers', () => {
		const published: RoomEntry = {
			kind: 'message',
			seq: 5,
			body: {
				kind: 'summary',
				at,
				from: 'product',
				to: 'priya',
				text: 'What happened.',
				covers: { from: 3, through: 3 },
				activation: 'closed:3:product:1',
			},
		};
		const entries = [writerNamed, person, question, closed3, published];
		expect(owedOf(replayState(entries, options))).toEqual([]);
		bind.once(rules.coversExchange, false);
		expect(owedOf(replayState(entries, options))).toHaveLength(1);
	});

	it('closes only when exchangeLive says nothing of the exchange is live', () => {
		const quiet = replayState([writerNamed, person, quietQuestion], options);
		expect(reconcile(quiet).steps).toEqual([{ type: 'close', from: 3, through: 3 }]);
		bind.once(rules.exchangeLive, true);
		expect(reconcile(quiet).steps).toEqual([]);
	});

	it.each(['admitted', 'replan', 'obsolete'] as const)(
		'plans a close only for the admitted outcome: %s',
		async (outcome) => {
			const quiet = replayState([composition, person, quietQuestion], options);
			bind.once(rules.closeAdmission, outcome);
			expect(reconcile(quiet).steps).toEqual(
				outcome === 'admitted' ? [{ type: 'close', from: 3, through: 3 }] : [],
			);
		},
	);

	it.each(['replan', 'obsolete'] as const)(
		'follows the queued %s close outcome',
		async (outcome) => {
			const runtime = createRuntime({
				clock: fakeClock(),
				execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
			});
			const room = stopAtEnd(
				await startRoom({
					name: roomName('binding-close'),
					runtime,
					agents: [scriptedAgent('product', 'Product.')],
				}),
			);
			const visit = await room.visit(definePerson({ name: 'priya', identity: 'Person.' }));
			const first = await visit.send({ text: 'Question.' });
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
			// Planning admits the close. The queued write returns the sentinel outcome.
			// Only replan must close without another delivery or clock advance.
			await room.reconcile();
			const body = vi.mocked(rules.closeAdmission).getMockImplementation();
			if (body === undefined) throw new Error('The rule has no body.');
			bind.onceWith(rules.closeAdmission, body);
			bind.once(rules.closeAdmission, outcome);
			await peer.lease({ activation, operation: 'release', reason: 'released', readThrough: 4 });
			await flush();
			expect(closedExchange(room, first.from) !== undefined).toBe(outcome === 'replan');
			await room.reconcile();
			await flush();
			expect(closedExchange(room, first.from)).toBeDefined();
		},
	);

	it('reports a scheduled say the unread entries that unreadBy names', async () => {
		const runtime = createRuntime({
			clock: fakeClock(),
			execution: piExecution({ sessions: 'memory', stream: scriptedStream(() => quiet()) }),
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('binding-unread'),
				runtime,
				agents: [scriptedAgent('product', 'Product.')],
			}),
		);
		const visit = await room.visit(definePerson({ name: 'priya', identity: 'Person.' }));
		const first = await visit.send({ text: 'Question.' });
		const peer = runningRoom(runtime, room.name);
		if (peer === undefined) throw new Error('The room is absent.');
		const activation = `message:${first.from}:product:1`;
		expect(await peer.lease({ activation, operation: 'claim' })).toHaveProperty('ok');
		const later = (key: string): CommitRequest => ({
			activation,
			key,
			readThrough: first.from - 1,
			intent: { kind: 'said', to: 'product', text: `Later ${key}.`, delaySeconds: 60 },
		});
		// The rule answers by its body: the question lies past the read position.
		expect(await peer.commit(later('record'))).toMatchObject({ unread: [{ seq: first.from }] });
		bind.always(rules.unreadBy, () => false);
		const none = await peer.commit(later('none'));
		expect(none).toHaveProperty('committed');
		expect(none).not.toHaveProperty('unread');
		bind.always(rules.unreadBy, () => true);
		expect(await peer.commit(later('all'))).toHaveProperty('unread');
		bind.restore(rules.unreadBy);
	});

	it('counts a seating as read through the entry only as ownEntryAfter answers', async () => {
		const results: string[] = [];
		const room = stopAtEnd(
			await startRoom({
				name: roomName('binding-own-entry'),
				runtime: createRuntime({
					clock: fakeClock(),
					execution: piExecution({
						sessions: 'memory',
						stream: scriptedStream((context) => {
							const read = toolResultTexts(context);
							if (read.length === 0) return seat('ana');
							results.splice(0, results.length, ...read);
							return read.length === 1 ? callTool('say', { text: 'Welcome.' }) : quiet();
						}),
					}),
				}),
				agents: [scriptedAgent('worker', 'Worker.'), scriptedAgent('ana', 'Ana.')],
				seats: { worker: 'broadcast' },
			}),
		);
		// A read position that no entry joins leaves the seating entry unread, so the say is missed.
		bind.once(seatRules.ownEntryAfter, 1_000_000);
		const visit = await room.visit(definePerson({ name: 'priya', identity: 'Person.' }));
		await visit.send({ text: 'Bring in ana.' });
		await waitForRoom(room);
		expect(results[1]).toContain('Not delivered');
	});
});
