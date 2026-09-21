import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/journal/journal.ts';
import { foldRoom } from '../src/room/fold.ts';
import { pendingFor, readView } from '../src/room/read.ts';
import { evolve } from '../src/room/transition.ts';
import type { ExchangeView, RoomRead } from '../src/types.ts';

const at = '2026-01-01T09:00:00.000Z';
const options = { attempts: 3, backoff: () => 0 };

const composition: Entry = {
	kind: 'composition',
	seq: 1,
	body: {
		version: 2,
		agents: [{ name: 'worker', identity: 'Worker.', attention: 'broadcast' }],
		available: [],
		at,
	},
};
const arrival = (seq: number, name: string): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'arrived', at, from: name, subject: name, identity: 'Person.' },
});
const said = (seq: number, from: string, to?: string): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'said', at, from, text: `Message ${seq}.`, ...(to === undefined ? {} : { to }) },
});
const summary = (seq: number, to: string, from: number, through: number): Entry => ({
	kind: 'message',
	seq,
	body: { kind: 'summary', at, from: 'worker', to, text: `For ${to}.`, covers: { from, through } },
});
const close = (seq: number, from: number, through: number): Entry => ({
	kind: 'close',
	seq,
	body: { owner: 'priya', from, through, at },
});
const abandoned = (seq: number, id: string): Entry => ({
	kind: 'lease',
	seq,
	body: { id, phase: 'ended', reason: 'abandoned', at, readThrough: 0, cause: 'permanent' },
});
const cancel = (seq: number, through?: number): Entry => ({
	kind: 'cancel',
	seq,
	body: {
		at,
		...(through === undefined ? {} : { close: { owner: 'priya', from: 4, through, at } }),
	},
});

const room = [composition, arrival(2, 'priya'), arrival(3, 'sam')];

const readOf = (entries: readonly Entry[]): RoomRead =>
	readView('room', foldRoom(entries, options), 0, entries.length, false);

const closed = (read: RoomRead) =>
	read.exchanges.filter(
		(exchange): exchange is Extract<ExchangeView, { status: 'closed' }> =>
			exchange.status === 'closed',
	);

describe('exchange outcomes', () => {
	it('reads complete when the exchange closes with nothing outstanding', () => {
		const read = readOf([...room, said(4, 'priya'), said(5, 'worker', 'priya'), close(6, 4, 5)]);
		expect(closed(read)[0]?.outcome).toEqual({ kind: 'complete' });
	});

	it('reads awaiting when the last spoken message asks a person who has said nothing since', () => {
		const entries = [...room, said(4, 'priya'), said(5, 'worker', 'sam'), close(6, 4, 5)];
		const read = readOf(entries);
		expect(closed(read)[0]?.outcome).toEqual({ kind: 'awaiting', person: 'sam' });
		expect(pendingFor(read, 'sam').map((exchange) => exchange.from)).toEqual([4]);
		expect(pendingFor(read, 'priya')).toEqual([]);
	});

	it('clears awaiting once the person speaks again', () => {
		const entries = [
			...room,
			said(4, 'priya'),
			said(5, 'worker', 'sam'),
			close(6, 4, 5),
			said(7, 'sam'),
		];
		const read = readOf(entries);
		expect(closed(read)[0]?.outcome).toEqual({ kind: 'complete' });
		expect(pendingFor(read, 'sam')).toEqual([]);
	});

	it('does not await the owner of the exchange', () => {
		const read = readOf([...room, said(4, 'priya'), said(5, 'worker', 'priya'), close(6, 4, 5)]);
		expect(closed(read)[0]?.outcome).toEqual({ kind: 'complete' });
		expect(pendingFor(read, 'priya')).toEqual([]);
	});

	it('does not await an agent', () => {
		const read = readOf([...room, said(4, 'priya'), said(5, 'worker', 'worker'), close(6, 4, 5)]);
		expect(closed(read)[0]?.outcome).toEqual({ kind: 'complete' });
	});

	it('reads exhausted when the room gave up on a response activation', () => {
		const entries = [...room, said(4, 'priya'), abandoned(5, 'message:4:worker:1'), close(6, 4, 4)];
		expect(closed(readOf(entries))[0]?.outcome).toEqual({ kind: 'exhausted' });
	});

	it('does not read exhausted for an abandoned summary', () => {
		const entries = [...room, said(4, 'priya'), close(5, 4, 4), abandoned(6, 'closed:4:worker:1')];
		expect(closed(readOf(entries))[0]?.outcome).toEqual({ kind: 'complete' });
	});

	it('reads cancelled before exhausted before awaiting', () => {
		const base = [...room, said(4, 'priya'), said(5, 'worker', 'sam')];
		const exhausted = [...base, abandoned(6, 'message:4:worker:1')];
		expect(closed(readOf([...base, close(6, 4, 5)]))[0]?.outcome.kind).toBe('awaiting');
		expect(closed(readOf([...exhausted, close(7, 4, 5)]))[0]?.outcome.kind).toBe('exhausted');
		expect(closed(readOf([...exhausted, cancel(7, 5)]))[0]?.outcome.kind).toBe('cancelled');
	});

	it('reads complete for a normal close that a later cancellation follows', () => {
		const entries = [...room, said(4, 'priya'), close(5, 4, 4), said(6, 'priya'), cancel(7, 6)];
		expect(closed(readOf(entries)).map((exchange) => exchange.outcome.kind)).toEqual([
			'complete',
			'cancelled',
		]);
	});

	it('lists one summary for each person who spoke', () => {
		const entries = [
			...room,
			said(4, 'priya'),
			said(5, 'sam'),
			close(6, 4, 5),
			summary(7, 'sam', 4, 5),
			summary(8, 'priya', 4, 5),
		];
		const [view] = closed(readOf(entries));
		expect(view?.summaries?.map((message) => message.to)).toEqual(['priya', 'sam']);
	});

	it('leaves out a summary for a person who did not speak', () => {
		const entries = [...room, said(4, 'priya'), close(5, 4, 4), summary(6, 'sam', 4, 4)];
		expect(closed(readOf(entries))[0]?.summaries).toBeUndefined();
	});

	it('reads the same outcomes from the incremental state as from the fold', () => {
		const entries = [
			...room,
			said(4, 'priya'),
			said(5, 'worker', 'sam'),
			close(6, 4, 5),
			said(7, 'priya'),
			cancel(8, 7),
		];
		let state = foldRoom(entries.slice(0, 3), options);
		for (const entry of entries.slice(3)) state = evolve(state, entry, options);
		expect(readView('room', state, 0, 8, false)).toEqual(readOf(entries));
	});
});
