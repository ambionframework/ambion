import type { JournalOpener, JournalStorage } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { createRuntime, readRoom } from '../src/index.ts';
import type { Close } from '../src/journal/events.ts';
import type { RoomState } from '../src/room/fold.ts';
import type { LeaseHold } from '../src/room/lease.ts';
import { readView } from '../src/room/read.ts';
import type { Message, RoomRead } from '../src/types.ts';
import { openFor } from './support/core-room.ts';
import { roomName } from './support/room.ts';
import { storages } from './support/storage.ts';

const opening: Message = {
	kind: 'said',
	seq: 2,
	at: '2026-01-01T00:00:01.000Z',
	from: 'priya',
	text: 'Question?',
};

const close = (summary?: string): Close => ({
	owner: 'priya',
	from: 2,
	through: 3,
	at: '2026-01-01T00:00:02.000Z',
	...(summary === undefined ? {} : { summary }),
});

const abandoned: LeaseHold = {
	id: 'closed:3:assistant:1',
	phase: 'ended',
	reason: 'abandoned',
	at: '2026-01-01T00:00:03.000Z',
	claimedAt: '2026-01-01T00:00:02.000Z',
	since: 3,
	until: 4,
	readThrough: 0,
};

function state(
	closes: Close[],
	messages: Message[],
	leases = new Map<string, LeaseHold>(),
	exchange: RoomState['exchange'] = undefined,
): RoomState {
	return {
		composition: {
			version: 2,
			goal: 'Keep the record coherent.',
			agents: [],
			available: [],
			seq: 1,
			at: '2026-01-01T00:00:00.000Z',
		},
		roster: [],
		reserve: [],
		people: new Map(),
		exchange,
		closes,
		cancelClosed: [],
		leases,
		deliveries: new Map(),
		pending: [],
		owed: [],
		due: [],
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
	};
}

async function appendRecord(
	journals: JournalOpener,
	name: string,
	entries: readonly { kind: string; body: unknown }[],
): Promise<void> {
	const storage: JournalStorage = await journals.open(name);
	let position = (await storage.read(0)).position;
	for (const entry of entries) {
		const landed = await storage.append({ ...entry, seq: position + 1, run }, position);
		if (landed === undefined) throw new Error('The test record moved while it was being written.');
		position = landed.position;
	}
}

const run = 'read-test-run';
const at = '2026-01-01T00:00:00.000Z';

/** A stored room where priya asks one question, and the entries that follow it. */
const record = (said: object, ...after: { kind: string; body: unknown }[]) => [
	{ kind: 'run', body: { at } },
	{
		kind: 'composition',
		body: {
			version: 2,
			agents: [{ name: 'assistant', identity: 'Assistant.', attention: 'none' }],
			available: [],
			at,
		},
	},
	{
		kind: 'message',
		body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
	},
	{ kind: 'message', body: { kind: 'said', at, from: 'priya', text: 'Question?', ...said } },
	...after,
];
const lease = (body: object) => ({ kind: 'lease', body: { at, readThrough: 4, ...body } });

describe('coherent room reads', () => {
	it('serializes every summary outcome and keeps late summaries with their close', () => {
		const published: Message = {
			kind: 'summary',
			seq: 5,
			at: '2026-01-01T00:00:05.000Z',
			from: 'assistant',
			to: 'priya',
			text: 'Done.',
			covers: { from: 2, through: 3 },
		};
		const open = { owner: 'sam', from: 4, at: '2026-01-01T00:00:04.000Z' };
		const read = () => {
			const snapshot = readView(
				'room',
				state(
					[close('assistant')],
					[
						opening,
						{ ...opening, seq: open.from, from: 'sam', at: open.at, text: 'New question?' },
						published,
					],
					undefined,
					open,
				),
				0,
				8,
				false,
			);
			if (!snapshot.initialized) throw new Error('Expected an initialized room.');
			return snapshot;
		};
		const snapshot = read();
		if (snapshot.exchange?.status !== 'open') throw new Error('Expected an open exchange.');
		expect('through' in snapshot.exchange).toBe(false);
		expect(snapshot.exchanges).toEqual([
			expect.objectContaining({
				status: 'closed',
				at: opening.at,
				through: 3,
				summary: { status: 'published', summary: published },
			}),
			{ status: 'open', ...open, activations: [] },
		]);
		const closed = snapshot.exchanges[0];
		if (closed?.status !== 'closed' || closed.summary.status !== 'published')
			throw new Error('Expected a published summary.');
		Reflect.set(closed.summary.summary, 'text', 'mutated');
		expect(read().exchanges[0]).toMatchObject({ summary: { summary: { text: 'Done.' } } });
	});

	it('reports pending, silent, and failed outcomes from one projection cut', () => {
		const pending = readView('room', state([close('assistant')], [opening]), 0, 4, false);
		const silent = readView('room', state([close()], [opening]), 0, 4, false);
		const failed = readView(
			'room',
			state([close('assistant')], [opening], new Map([['closed:3:assistant:1', abandoned]])),
			0,
			4,
			false,
		);
		const outcome = (snapshot: RoomRead) => {
			if (!snapshot.initialized) throw new Error('Expected an initialized room.');
			const exchange = snapshot.exchanges[0];
			if (exchange?.status !== 'closed') throw new Error('Expected a closed exchange.');
			return exchange.summary;
		};
		expect(outcome(pending)).toEqual({ status: 'pending', writer: 'assistant' });
		expect(outcome(silent)).toEqual({ status: 'silent' });
		expect(outcome(failed)).toEqual({ status: 'failed' });
		expect(pending.watermark).toBe(4);
	});

	it('validates cursors even when the room has no composition', () => {
		expect(() =>
			readView('missing', { ...state([], []), composition: undefined }, 0, 0, { since: -1 }),
		).toThrow(/cursor/i);
	});
});

describe.each(storages)('stored room reads on $name storage', (storage) => {
	it.each([
		['released', 'silent'],
		['abandoned', 'failed'],
	] as const)(
		'observes a lease that ends %s as a %s summary, at a new watermark',
		async (reason, expected) => {
			const opened = await openFor(storage);
			const runtime = createRuntime({
				storage: opened.storage,
				clock: { now: () => 0, alarm: () => () => {} },
			});
			const name = roomName('room-read-lease');
			await appendRecord(
				opened.journals,
				name,
				record(
					{},
					{
						kind: 'close',
						body: { owner: 'priya', from: 4, through: 4, at, summary: 'assistant' },
					},
					lease({ id: 'closed:4:assistant:1', phase: 'running', expiresAt: 60_000 }),
				),
			);
			const pending = await readRoom(name, { runtime });
			const first = pending.exchanges[0];
			expect(first?.status === 'closed' && first.summary).toEqual({
				status: 'pending',
				writer: 'assistant',
			});
			await appendRecord(opened.journals, name, [
				lease({ id: 'closed:4:assistant:1', phase: 'ended', reason }),
			]);
			const complete = await readRoom(name, { runtime });
			expect(complete.messages).toHaveLength(pending.messages.length);
			expect(complete.watermark).toBeGreaterThan(pending.watermark);
			expect(complete.exchanges[0]).toMatchObject({ summary: { status: expected } });
		},
	);

	it('changes live participant status with the clock at one watermark', async () => {
		const opened = await openFor(storage);
		let now = 1_000;
		const runtime = createRuntime({
			storage: opened.storage,
			clock: { now: () => now, alarm: () => () => {} },
		});
		const name = roomName('room-read-clock');
		await appendRecord(
			opened.journals,
			name,
			record(
				{ wakes: ['assistant'] },
				lease({ id: 'message:4:assistant:1', phase: 'running', expiresAt: 2_000, readThrough: 0 }),
			),
		);
		const seat = (read: RoomRead) => read.participants.find((p) => p.name === 'assistant');
		const active = await readRoom(name, { runtime, messages: false });
		now = 3_000;
		const idle = await readRoom(name, { runtime, messages: false });
		expect(active.watermark).toBe(idle.watermark);
		expect(seat(active)).toMatchObject({ status: 'active' });
		expect(seat(idle)).toMatchObject({ status: 'idle' });
	});
});
