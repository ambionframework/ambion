import { describe, expect, it } from 'vitest';
import { decodeActivationId } from '../src/activation-id.ts';
import type { Body, Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { evolve } from '../src/room/transition.ts';
import type { Message } from '../src/types.ts';
import type { EndReason, LeaseChange } from '../src/wire.ts';

const at = '2026-01-01T09:00:00.000Z';
const retry = { backoff: (attempt: number) => attempt * 1_000 };

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		summary: 'assistant',
		agents: [
			{ name: 'alpha', identity: 'Alpha.', attention: 'broadcast' },
			{ name: 'beta', identity: 'Beta.', attention: 'broadcast' },
			{ name: 'assistant', identity: 'Assistant.', attention: 'none' },
		],
		available: [],
		at,
	},
};

const message = (
	seq: number,
	from: string | undefined,
	extra: Partial<Body<Message>> = {},
): Entry => ({
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

const presence = (seq: number, kind: 'seated' | 'unseated', subject: string): Entry => ({
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
	| Omit<Extract<LeaseChange, { phase: 'running' }>, 'id' | 'at'>
	| Omit<Extract<LeaseChange, { phase: 'ended' }>, 'id' | 'at'>;

const lease = (seq: number, id: string, change: LeaseDraft): Entry => ({
	kind: 'lease',
	seq,
	body: { ...change, id, at } as LeaseChange,
});

const entries: Entry[] = [
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
		body: { owner: 'priya', from: 3, through: 27, at, summary: 'assistant' },
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
			activationId: 'closed:27:assistant:1',
		},
	},
];

type HistoricalLease = { id: string; since: number; until: number | undefined };
type OracleDelivery = { recipients: Set<string>; steers: Set<string> };

function historicalLeases(history: readonly Entry[]): Map<string, HistoricalLease> {
	const leases = new Map<string, HistoricalLease>();
	for (const entry of history) {
		if (entry.kind !== 'lease') continue;
		const current = leases.get(entry.body.id);
		if (current?.until !== undefined) continue;
		if (entry.body.phase === 'running') {
			leases.set(entry.body.id, {
				id: entry.body.id,
				since: current?.since ?? entry.seq,
				until: undefined,
			});
		} else {
			leases.set(entry.body.id, {
				id: entry.body.id,
				since: current?.since ?? entry.seq,
				until: entry.seq,
			});
		}
	}
	return leases;
}

function historicalDeliveries(
	history: readonly Entry[],
	roster: ReadonlySet<string>,
): Map<number, OracleDelivery> {
	const leases = historicalLeases(history);
	const deliveries = new Map<number, OracleDelivery>();
	for (const entry of history) {
		if (entry.kind !== 'message') continue;
		const body = entry.body as Message;
		const explicit = new Set(body.wakes ?? []);
		const steers = new Set<string>();
		for (const held of leases.values()) {
			const id = decodeActivationId(held.id);
			if (
				id?.source === 'message' &&
				id.seat !== body.from &&
				!explicit.has(id.seat) &&
				held.since < entry.seq &&
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

function freeze(value: unknown): void {
	if (value === null || typeof value !== 'object') return;
	if (value instanceof Map) {
		for (const entry of value.values()) freeze(entry);
	} else {
		for (const entry of Object.values(value)) freeze(entry);
	}
	Object.freeze(value);
}

function pendingState(
	reason: EndReason,
	readThrough: number,
	removed = false,
): ReturnType<typeof foldRoom> {
	const history: Entry[] = [
		composition,
		message(40, 'priya', { wakes: ['alpha'] }),
		lease(41, 'message:40:alpha:1', { phase: 'running', expiresAt: 60_000, readThrough: 0 }),
		lease(42, 'message:40:alpha:1', { phase: 'ended', reason, readThrough }),
	];
	if (removed) history.push(presence(43, 'unseated', 'alpha'));
	return foldRoom(history, retry);
}

describe('delivery replay projection', () => {
	it('matches an independent historical interval oracle after current roster filtering', () => {
		let state = foldRoom([], retry);
		const history: Entry[] = [];
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
		const history: Entry[] = [];
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
		expect(pendingState('failed', 0).pending).toMatchObject([
			expect.objectContaining({ seq: 40, unsuccessfulAttempts: 1 }),
		]);
		expect(pendingState('expired', 0).pending).toMatchObject([
			expect.objectContaining({ seq: 40, unsuccessfulAttempts: 1 }),
		]);
		expect(pendingState('released', 0).pending).toMatchObject([
			expect.objectContaining({ seq: 40, unsuccessfulAttempts: 1 }),
		]);
		expect(pendingState('released', 40).pending).toEqual([]);
		expect(pendingState('revoked', 0).pending).toEqual([]);
		expect(pendingState('failed', 0, true).pending).toEqual([]);
	});
});
