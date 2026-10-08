/**
 * Who hears a message: the delivery rule over the lease intervals, and its
 * projection in the fold, which an independent reading of the history
 * checks entry by entry.
 */
import { describe, expect, it } from 'vitest';
import { decodeActivationId } from '../src/activation-id.ts';
import type { Lease, Seating } from '../src/journal/entries.ts';
import type { Body, RoomEntry } from '../src/journal/journal.ts';
import { messageDelivery } from '../src/room/delivery.ts';
import type { LeaseHold } from '../src/room/lease.ts';
import type { Attention, EndReason, Message } from '../src/types.ts';
import { freeze } from './support/core-failure.ts';
import { evolve } from './support/evolve.ts';
import { activationOf, foldRoom, pendingOf, replayState } from './support/fold.ts';

const at = '2026-01-01T09:00:00.000Z';

const said = (seq = 10, wakes?: string[]): Message => ({
	kind: 'said',
	seq,
	at,
	from: 'priya',
	text: 'Question.',
	...(wakes === undefined ? {} : { wakes }),
});

const running = (id: string, openedSeq: number, expiresAt = 1): LeaseHold => ({
	id,
	activation: activationOf(id),
	phase: 'running',
	expiresAt,
	at,
	claimedAt: at,
	openedSeq,
	readThrough: 0,
});

const ended = (
	id: string,
	openedSeq: number,
	until: number,
	reason: Extract<LeaseHold, { phase: 'ended' }>['reason'] = 'released',
): LeaseHold => ({
	id,
	activation: activationOf(id),
	phase: 'ended',
	reason,
	at,
	claimedAt: at,
	openedSeq,
	until,
	readThrough: 0,
});

const leases = (...holds: LeaseHold[]): ReadonlyMap<string, LeaseHold> =>
	new Map(holds.map((hold) => [hold.id, hold]));

describe('message delivery rule', () => {
	it('deduplicates an explicit wake with an active steer and excludes the author', () => {
		expect(
			messageDelivery(
				said(10, ['beta', 'author']),
				leases(
					running('message:3:beta:1', 3),
					running('message:3:priya:1', 3),
					running('message:3:gamma:1', 3),
				),
				[],
			),
		).toEqual({
			wakes: ['beta', 'author'],
			steers: [{ seat: 'gamma', activation: 'message:3:gamma:1' }],
		});
	});

	it('uses journal intervals and ordinary message causes only', () => {
		expect(
			messageDelivery(
				said(),
				leases(
					ended('message:3:before:1', 3, 9),
					ended('message:3:at-end:1', 3, 10),
					ended('message:3:after:1', 3, 11),
					running('message:3:running:1', 3, 0),
					running('closed:10:closed:1', 3),
				),
				[],
			),
		).toEqual({
			wakes: [],
			steers: [
				{ seat: 'at-end', activation: 'message:3:at-end:1' },
				{ seat: 'after', activation: 'message:3:after:1' },
				{ seat: 'running', activation: 'message:3:running:1' },
			],
		});
	});

	it('leaves explicit recorded wakes intact when no historical lease can steer', () => {
		expect(messageDelivery(said(10, ['removed', 'unknown']), leases(), [])).toEqual({
			wakes: ['removed', 'unknown'],
			steers: [],
		});
	});

	describe('attention decides who a message steers', () => {
		const seat = (name: string, attention: Attention): Seating => ({
			name,
			identity: `${name}.`,
			attention,
		});
		const roster = [seat('lead', 'broadcast'), seat('builder', 'named'), seat('reviewer', 'named')];
		const busy = leases(
			running('message:3:lead:1', 3),
			running('message:3:builder:1', 3),
			running('message:3:reviewer:1', 3),
		);
		const seats = (message: Message): string[] =>
			messageDelivery(message, busy, roster).steers.map((steer) => steer.seat);

		const say = (from: string, to?: string): Message => ({
			kind: 'said',
			seq: 10,
			at,
			from,
			text: 'Text.',
			...(to === undefined ? {} : { to }),
		});
		const system = (to?: string): Message => ({
			kind: 'system',
			seq: 10,
			at,
			text: 'Note.',
			...(to === undefined ? {} : { to }),
		});
		const cases: [string, Message, string[]][] = [
			['an undirected say of a person steers only a seat at broadcast', say('priya'), ['lead']],
			['an undirected say of a seat steers only a seat at broadcast', say('builder'), ['lead']],
			['a directed say steers the seat it names and no other', say('lead', 'builder'), ['builder']],
			[
				'a directed say of a person steers the seat it names and no other',
				say('priya', 'reviewer'),
				['reviewer'],
			],
			['a system message with no to steers only a seat at broadcast', system(), ['lead']],
			['a system message with to steers its target alone', system('builder'), ['builder']],
		];
		it.each(cases)('%s', (_name, message, expected) => {
			expect(seats(message)).toEqual(expected);
		});
	});
});

const retry = { backoff: (attempt: number) => attempt * 1_000 };

const composition: RoomEntry = {
	kind: 'composition',
	seq: 1,
	body: {
		summaryWriter: 'assistant',
		seated: [
			{ name: 'alpha', identity: 'Alpha.', attention: 'broadcast' },
			{ name: 'beta', identity: 'Beta.', attention: 'broadcast' },
			{ name: 'assistant', identity: 'Assistant.', attention: 'none' },
		],
		reserve: [],
		at,
	},
};

const message = (
	seq: number,
	from: string | undefined,
	extra: Partial<Body<Message>> = {},
): RoomEntry => ({
	kind: 'message',
	seq,
	body: {
		kind: 'said',
		at,
		from: from ?? '',
		text: `Message ${seq}.`,
		...extra,
	} as Body<Message>,
});

const presence = (seq: number, kind: 'seated' | 'unseated', subject: string): RoomEntry => ({
	kind: 'message',
	seq,
	body: (kind === 'seated'
		? {
				kind,
				at,
				subject,
				identity: `${subject}.`,
				attention: 'broadcast',
			}
		: { kind, at, subject }) as Body<Message>,
});

type LeaseDraft =
	| Omit<Extract<Lease, { phase: 'running' }>, 'id' | 'at'>
	| Omit<Extract<Lease, { phase: 'ended' }>, 'id' | 'at'>;

const lease = (seq: number, id: string, change: LeaseDraft): RoomEntry => ({
	kind: 'lease',
	seq,
	body: { ...change, id, at } as Lease,
});

const entries: RoomEntry[] = [
	composition,
	message(2, 'priya', { kind: 'arrived', subject: 'priya', identity: 'Priya.' }),
	message(3, 'priya', { wakes: ['alpha', 'beta'] }),
	lease(4, 'message:3:alpha:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	lease(5, 'message:3:alpha:1', { phase: 'running', expiresAt: 90_000, readThrough: 0 }),
	lease(6, 'opened:3:assistant:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	message(7, 'alpha'),
	lease(8, 'opened:3:assistant:1', { phase: 'ended', reason: 'released', readThrough: 3 }),
	message(9, 'priya', { wakes: ['beta'] }),
	lease(10, 'message:3:alpha:1', { phase: 'ended', reason: 'released', readThrough: 3 }),
	lease(11, 'message:9:beta:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	message(12, 'priya'),
	lease(13, 'message:9:beta:1', { phase: 'ended', reason: 'failed', readThrough: 0 }),
	message(14, 'priya', { wakes: ['alpha'] }),
	lease(15, 'message:14:alpha:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	message(16, 'priya'),
	lease(17, 'message:14:alpha:1', { phase: 'ended', reason: 'expired', readThrough: 0 }),
	message(18, 'priya', { wakes: ['gamma'] }),
	presence(19, 'seated', 'gamma'),
	lease(20, 'message:18:gamma:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	message(21, 'priya'),
	lease(22, 'message:18:gamma:1', { phase: 'ended', reason: 'revoked', readThrough: 0 }),
	message(23, 'priya'),
	presence(24, 'unseated', 'beta'),
	message(25, 'priya', { wakes: ['beta'] }),
	presence(26, 'seated', 'beta'),
	message(27, 'priya', { wakes: ['beta'] }),
	lease(28, 'message:27:beta:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	{
		kind: 'close',
		seq: 29,
		body: { person: 'priya', from: 3, through: 27, at, summaryWriter: 'assistant' },
	},
	lease(30, 'closed:27:assistant:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
	{
		kind: 'message',
		seq: 31,
		body: {
			kind: 'summary',
			at,
			from: 'assistant',
			to: 'priya',
			text: 'Summary.',
			covers: { from: 3, through: 27 },
			activation: 'closed:27:assistant:1',
		},
	},
	message(32, 'priya', { to: 'alpha', wakes: ['alpha'] }),
];

type HistoricalLease = { id: string; openedSeq: number; until: number | undefined };
type OracleDelivery = { recipients: Set<string>; steers: Set<string> };

function historicalLeases(history: readonly RoomEntry[]): Map<string, HistoricalLease> {
	const leases = new Map<string, HistoricalLease>();
	for (const entry of history) {
		if (entry.kind !== 'lease') continue;
		const { id, phase } = entry.body;
		const current = leases.get(id);
		if (current?.until !== undefined) continue;
		const until = phase === 'running' ? undefined : entry.seq;
		leases.set(id, { id, openedSeq: current?.openedSeq ?? entry.seq, until });
	}
	return leases;
}

/** The attention of each seat that the history seated, read again from the entries. */
function historicalAttention(
	history: readonly RoomEntry[],
	before: number,
): Map<string, Attention> {
	const attention = new Map<string, Attention>();
	for (const entry of history) {
		if (entry.seq >= before) break;
		if (entry.kind === 'composition')
			for (const seat of entry.body.seated) attention.set(seat.name, seat.attention);
		if (entry.kind !== 'message') continue;
		const body = entry.body as Message;
		if (body.kind === 'seated') attention.set(body.subject, body.attention ?? 'broadcast');
		if (body.kind === 'unseated') attention.delete(body.subject);
	}
	return attention;
}

/** A say or a system message reaches a seat at work by its name, or by a wide enough attention. */
function reaches(body: Message, seat: string, held: Attention | undefined): boolean {
	if (body.kind !== 'said' && body.kind !== 'system') return true;
	if (held === undefined || body.to === seat) return true;
	return body.to === undefined && (held === 'broadcast' || held === 'presence');
}

function historicalDeliveries(
	history: readonly RoomEntry[],
	roster: ReadonlySet<string>,
): Map<number, OracleDelivery> {
	const leases = historicalLeases(history);
	const deliveries = new Map<number, OracleDelivery>();
	for (const entry of history) {
		if (entry.kind !== 'message') continue;
		const body = entry.body as Message;
		const explicit = new Set(body.wakes ?? []);
		const steers = new Set<string>();
		const attention = historicalAttention(history, entry.seq);
		for (const held of leases.values()) {
			const id = decodeActivationId(held.id);
			if (
				id?.source === 'message' &&
				id.seat !== body.from &&
				!explicit.has(id.seat) &&
				reaches(body, id.seat, attention.get(id.seat)) &&
				held.openedSeq < entry.seq &&
				(held.until === undefined || entry.seq <= held.until)
			)
				steers.add(id.seat);
		}
		deliveries.set(entry.seq, {
			recipients: new Set([...explicit, ...steers].filter((seat) => roster.has(seat))),
			steers,
		});
	}
	return deliveries;
}

function pendingState(
	reason: EndReason,
	readThrough: number,
	removed = false,
): ReturnType<typeof replayState> {
	const history: RoomEntry[] = [
		composition,
		message(40, 'priya', { wakes: ['alpha'] }),
		lease(41, 'message:40:alpha:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
		lease(42, 'message:40:alpha:1', { phase: 'ended', reason, readThrough }),
	];
	if (removed) history.push(presence(43, 'unseated', 'alpha'));
	return replayState(history, retry);
}

describe('delivery replay projection', () => {
	it('matches an independent historical interval oracle after current roster filtering', () => {
		let state = foldRoom([], retry);
		const history: RoomEntry[] = [];
		for (const entry of entries) {
			history.push(entry);
			state = evolve(state, entry, retry);
			const roster = new Set(state.roster.map((seat) => seat.name));
			const expected = historicalDeliveries(history, roster);
			for (const [seq, delivery] of expected) {
				const actual = state.deliveries.get(seq);
				expect(actual).toBeDefined();
				expect(
					new Set(
						[...(actual?.wakes ?? []), ...(actual?.steers.map((steer) => steer.seat) ?? [])].filter(
							(seat) => roster.has(seat),
						),
					),
				).toEqual(delivery.recipients);
				expect(new Set(actual?.steers.map((steer) => steer.seat) ?? [])).toEqual(delivery.steers);
			}
		}
	});

	it('keeps every earlier delivery projection unchanged through evolve', () => {
		let state = foldRoom([], retry);
		const history: RoomEntry[] = [];
		const retained: { state: typeof state; snapshot: typeof state }[] = [];
		for (const entry of entries) {
			retained.push({ state, snapshot: structuredClone(state) });
			freeze(state);
			history.push(entry);
			state = evolve(state, entry, retry);
			expect(state).toEqual(foldRoom(history, retry));
		}
		for (const previous of retained) expect(previous.state).toEqual(previous.snapshot);
	});

	it('retains unconsumed work for retry and clears consumed or removed work', () => {
		const retained = [expect.objectContaining({ position: 40, unsuccessfulAttempts: 1 })];
		for (const reason of ['failed', 'expired', 'released'] as const)
			expect(pendingOf(pendingState(reason, 0))).toMatchObject(retained);
		expect(pendingOf(pendingState('released', 40))).toEqual([]);
		expect(pendingOf(pendingState('revoked', 0))).toEqual([]);
		expect(pendingOf(pendingState('failed', 0, true))).toEqual([]);
	});
});
