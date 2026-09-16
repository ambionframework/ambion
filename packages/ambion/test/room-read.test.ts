import type { JournalOpener, JournalStorage } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { createRuntime, readRoom } from '../src/index.ts';
import type { Close } from '../src/journal/events.ts';
import type { RoomState } from '../src/room/fold.ts';
import type { LeaseHold } from '../src/room/lease.ts';
import { readView } from '../src/room/read.ts';
import type { Message, RoomSnapshot } from '../src/types.ts';
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

const lease = (reason: 'abandoned' | 'released'): LeaseHold => ({
	id: 'closed:3:assistant:1',
	phase: 'ended',
	reason,
	at: '2026-01-01T00:00:03.000Z',
	claimedAt: '2026-01-01T00:00:02.000Z',
	since: 3,
	until: 4,
	readThrough: 0,
});

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
	entries: readonly { kind: string; body: unknown; seq: number; run: string }[],
): Promise<void> {
	const storage: JournalStorage = await journals.open(name);
	let position = (await storage.read(0)).position;
	for (const entry of entries) {
		const landed = await storage.append(entry, position);
		if (landed === undefined) throw new Error('The test record moved while it was being written.');
		position = landed.position;
	}
}

const run = 'read-test-run';
const at = '2026-01-01T00:00:00.000Z';
const composition = {
	version: 2 as const,
	agents: [{ name: 'assistant', identity: 'Assistant.', attention: 'none' as const }],
	available: [],
	at,
};

const recordPrefix = [
	{ kind: 'run', body: { at }, seq: 1, run },
	{ kind: 'composition', body: composition, seq: 2, run },
	{
		kind: 'message',
		body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
		seq: 3,
		run,
	},
	{
		kind: 'message',
		body: { kind: 'said', at, from: 'priya', text: 'Question?' },
		seq: 4,
		run,
	},
];

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
		if (snapshot.exchange === undefined || snapshot.exchange.status !== 'open')
			throw new Error('Expected an open exchange.');
		expect('through' in snapshot.exchange).toBe(false);
		expect(snapshot.exchanges).toEqual([
			expect.objectContaining({
				status: 'closed',
				at: opening.at,
				through: 3,
				summary: { status: 'published', summary: published },
			}),
			{ status: 'open', ...open },
		]);
		const closed = snapshot.exchanges[0];
		if (closed === undefined || closed.status !== 'closed' || closed.summary.status !== 'published')
			throw new Error('Expected a published summary.');
		Reflect.set(closed.summary.summary, 'text', 'mutated');
		const again = readView(
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
		if (!again.initialized) throw new Error('Expected an initialized room.');
		const summary = again.exchanges[0];
		expect(
			summary !== undefined && summary.status === 'closed' && summary.summary.status === 'published'
				? summary.summary.summary.text
				: undefined,
		).toBe('Done.');
	});

	it('reports pending, silent, and failed outcomes from one projection cut', () => {
		const pending = readView('room', state([close('assistant')], [opening]), 0, 4, false);
		const silent = readView('room', state([close()], [opening]), 0, 4, false);
		const failed = readView(
			'room',
			state(
				[close('assistant')],
				[opening],
				new Map([['closed:3:assistant:1', lease('abandoned')]]),
			),
			0,
			4,
			false,
		);
		const outcome = (snapshot: RoomSnapshot) => {
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

	it.each(storages)(
		'observes lease-only summary changes and watermark on $name storage',
		async (storage) => {
			const opened = await storage.open();
			const runtime = createRuntime({
				storage: opened.storage,
				clock: { now: () => 0, alarm: () => () => {} },
			});
			try {
				for (const [reason, expected] of [
					['released', 'silent'],
					['abandoned', 'failed'],
				] as const) {
					const name = roomName(`room-read-lease-${storage.name}`);
					await appendRecord(opened.journals, name, [
						...recordPrefix,
						{
							kind: 'close',
							body: { owner: 'priya', from: 4, through: 4, at, summary: 'assistant' },
							seq: 5,
							run,
						},
						{
							kind: 'lease',
							body: {
								id: 'closed:4:assistant:1',
								phase: 'running',
								expiresAt: 60_000,
								at,
								readThrough: 4,
							},
							seq: 6,
							run,
						},
					]);
					const pending = await readRoom(name, { runtime });
					const pendingMessageCount = pending.messages.length;
					expect(
						pending.initialized && pending.exchanges[0]?.status === 'closed'
							? pending.exchanges[0].summary
							: undefined,
					).toEqual({ status: 'pending', writer: 'assistant' });
					const journal = await opened.journals.open(name);
					const before = await journal.read(0);
					await journal.append(
						{
							kind: 'lease',
							body: {
								id: 'closed:4:assistant:1',
								phase: 'ended',
								reason,
								at,
								readThrough: 4,
							},
							seq: 7,
							run,
						},
						before.position,
					);
					const complete = await readRoom(name, { runtime });
					if (!pending.initialized || !complete.initialized)
						throw new Error('Expected initialized records.');
					expect(complete.messages).toHaveLength(pendingMessageCount);
					expect(complete.watermark).toBeGreaterThan(pending.watermark);
					expect(complete.exchanges[0]).toMatchObject({ summary: { status: expected } });
				}
			} finally {
				await opened.dispose();
			}
		},
	);

	it.each(storages)(
		'changes live participant status with the clock at one watermark on $name storage',
		async (storage) => {
			const opened = await storage.open();
			let now = 1_000;
			const runtime = createRuntime({
				storage: opened.storage,
				clock: { now: () => now, alarm: () => () => {} },
			});
			const name = roomName(`room-read-clock-${storage.name}`);
			try {
				await appendRecord(opened.journals, name, [
					{ kind: 'run', body: { at }, seq: 1, run },
					{ kind: 'composition', body: composition, seq: 2, run },
					{
						kind: 'message',
						body: { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' },
						seq: 3,
						run,
					},
					{
						kind: 'message',
						body: { kind: 'said', at, from: 'priya', text: 'Question?', wakes: ['assistant'] },
						seq: 4,
						run,
					},
					{
						kind: 'lease',
						body: {
							id: 'message:4:assistant:1',
							phase: 'running',
							expiresAt: 2_000,
							at,
							readThrough: 0,
						},
						seq: 5,
						run,
					},
				]);
				const active = await readRoom(name, { runtime, messages: false });
				now = 3_000;
				const idle = await readRoom(name, { runtime, messages: false });
				const activeSeat = active.participants.find(
					(participant) => participant.name === 'assistant',
				);
				const idleSeat = idle.participants.find((participant) => participant.name === 'assistant');
				expect(active.watermark).toBe(idle.watermark);
				expect(activeSeat).toMatchObject({ status: 'active' });
				expect(idleSeat).toMatchObject({ status: 'idle' });
			} finally {
				await opened.dispose();
			}
		},
	);

	it('validates cursors even when the room has no composition', () => {
		expect(() =>
			readView('missing', { ...state([], []), composition: undefined }, 0, 0, { since: -1 }),
		).toThrow(/cursor/i);
	});
});
