import type { JournalOpener } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { piExecution } from '../../pi/src/index.ts';
import {
	createRuntime,
	defineHuman,
	type ExchangeRead,
	readExchange,
	startRoom,
} from '../src/index.ts';
import { exchangeActivation } from '../src/room/exchange.ts';
import { openStorage, settledFlag } from './support/core-exchange.ts';
import { deferred, roomName, scriptedAgent, tick, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';
import { stopAtEnd } from './support/stop.ts';
import { type Storage, storages } from './support/storage.ts';

const at = '2026-01-01T00:00:00.000Z';
const run = 'exchange-read-run';
const firstFrom = 4;

type Written = { kind: string; body: unknown; seq: number; run: string };
const entry = (kind: string, body: unknown, seq = 0): Written => ({ kind, body, seq, run });

const record: readonly Written[] = [
	entry('run', { at }, 1),
	entry(
		'composition',
		{
			version: 2,
			goal: 'Keep the record coherent.',
			agents: [{ name: 'assistant', identity: 'Assistant.', attention: 'none' }],
			available: [],
			at,
		},
		2,
	),
	entry('message', { kind: 'arrived', at, from: 'priya', subject: 'priya', identity: 'Priya.' }, 3),
	entry(
		'message',
		{ kind: 'said', at, from: 'priya', text: 'First question?', wakes: ['assistant'] },
		firstFrom,
	),
	entry(
		'close',
		{ owner: 'priya', from: firstFrom, through: firstFrom, at, summary: 'assistant' },
		5,
	),
	entry('message', { kind: 'said', at, from: 'priya', text: 'Second question?' }, 6),
	entry(
		'message',
		{
			kind: 'summary',
			at,
			from: 'assistant',
			to: 'priya',
			text: 'First answer.',
			covers: { from: firstFrom, through: firstFrom },
		},
		7,
	),
	// An administrative entry advances the journal without becoming a message.
	entry('run', { at }, 8),
];

const published = {
	status: 'published',
	summary: { text: 'First answer.', covers: { from: firstFrom, through: firstFrom } },
};

async function appendRecord(journals: JournalOpener, name: string, entries: readonly Written[]) {
	const storage = await journals.open(name);
	let position = (await storage.read(0)).position;
	for (const written of entries) {
		const landed = await storage.append(written, position);
		if (landed === undefined) throw new Error('The test record moved while it was being written.');
		position = landed.position;
	}
}

/** A stopped room over the record and any entries after it, and a runtime that reads it. */
async function seeded(storage: Storage, extra: readonly Written[] = []) {
	const opened = await openStorage(storage);
	const name = roomName('exchange-read');
	await appendRecord(opened.journals, name, [...record, ...extra]);
	const runtime = createRuntime({
		storage: opened.storage,
		clock: { now: () => 0, alarm: () => () => {} },
	});
	const read = (from: number) => readExchange(name, from, { runtime });
	return { name, opened, runtime, read };
}

function closedOf(read: ExchangeRead | undefined) {
	if (read === undefined || read.exchange.status !== 'closed')
		throw new Error('Expected a closed exchange.');
	return read.exchange;
}

describe.each(storages)('readExchange on $name storage', (storage) => {
	it('reads an open exchange immediately while the live wait remains pending', async () => {
		const opened = await openStorage(storage);
		const started = deferred();
		const release = deferred();
		const runtime = createRuntime({
			storage: opened.storage,
			clock: { now: () => 0, alarm: () => () => {} },
		});
		const room = stopAtEnd(
			await startRoom({
				name: roomName('exchange-read-open'),
				runtime,
				agents: [scriptedAgent('worker')],
				execution: piExecution({
					stream: scripted(async (context) => {
						if (!contextText(context).includes('What is open?')) return quiet();
						started.resolve();
						await release.promise;
						return quiet();
					}),
				}),
			}),
		);
		const visit = await room.visit(defineHuman({ name: 'priya', identity: 'Project manager.' }));
		await waitForRoom(room, 'settled');
		const handle = await visit.send({ text: 'What is open?' });
		await started.promise;

		const read = await readExchange(room.name, handle.from, { runtime });
		expect(read?.exchange).toMatchObject({ status: 'open', from: handle.from });
		expect(read?.messages.map((message) => message.seq)).toEqual([handle.from]);

		const waiting = handle.waitForClose();
		const closed = settledFlag(waiting);
		await tick();
		expect(closed()).toBe(false);
		release.resolve();
		await waiting;
	});

	it('reads a stopped record without appending: open, closed, missing, and detached', async () => {
		const { name, opened, read } = await seeded(storage);
		const position = async () => (await (await opened.journals.open(name)).read(0)).position;
		const before = await position();

		// The late summary follows the opening of the next exchange, but stays with its close.
		const open = await read(6);
		expect(open?.exchange).toEqual({
			status: 'open',
			owner: 'priya',
			from: 6,
			at,
			activations: [],
		});
		expect(open?.messages.map((message) => message.seq)).toEqual([6]);
		const first = await read(firstFrom);
		const closed = closedOf(first);
		expect(first?.messages.map((message) => message.seq)).toEqual([firstFrom]);
		expect(first?.messages.every((message) => message.kind !== 'summary')).toBe(true);
		expect(closed.summary).toMatchObject(published);
		expect(closed).not.toHaveProperty('usage');
		expect(first?.watermark).toBe(8);
		expect(await position()).toBe(before);

		for (const interior of [3, 5, 7]) expect(await read(interior)).toBeUndefined();
		expect(await read(99)).toBeUndefined();
		const runtime = createRuntime({ storage: opened.storage });
		expect(await readExchange(roomName('exchange-read-absent'), 1, { runtime })).toBeUndefined();

		// Nested values are detached on every read.
		const message = first?.messages[0];
		if (message?.kind !== 'said' || closed.summary.status !== 'published')
			throw new Error('Expected the opening message and a published summary.');
		message.wakes?.push('mutated');
		closed.summary.summary.covers.from = 99;
		closed.summary.summary.text = 'mutated';
		const again = await read(firstFrom);
		const original = again?.messages[0];
		expect(original?.kind === 'said' ? original.wakes : undefined).toEqual(['assistant']);
		expect(closedOf(again).summary).toMatchObject(published);
	});

	it('lists every activation with its seat, attempt, purpose, outcome, and summed usage', async () => {
		const lease = (body: object) => entry('lease', body);
		const ended = (id: string, reason: string, extra: object = {}) =>
			lease({ id, phase: 'ended', reason, at, readThrough: 0, ...extra });
		const spent = (input: number, cost?: number) => ({
			input,
			output: input * 2,
			cacheRead: 1,
			cacheWrite: 0,
			...(cost === undefined ? {} : { cost }),
		});
		const { read } = await seeded(storage, [
			ended('message:4:assistant:1', 'failed', { cause: 'transient', usage: spent(10, 0.5) }),
			ended('message:4:assistant:2', 'released', { usage: spent(20, 0.25) }),
			ended('closed:4:assistant:1', 'revoked', { usage: spent(5) }),
			// Outside the range of the first exchange.
			ended('message:6:assistant:1', 'released', { usage: spent(1000, 9) }),
			lease({ id: 'message:6:assistant:2', phase: 'running', expiresAt: 10, at, readThrough: 0 }),
		]);
		const closed = closedOf(await read(firstFrom));
		expect(closed.usage).toEqual({
			input: 35,
			output: 70,
			cacheRead: 3,
			cacheWrite: 0,
			cost: 0.75,
		});
		const activation = (id: string, attempt: number, purpose: string, outcome: object) => ({
			id,
			seat: 'assistant',
			attempt,
			purpose,
			outcome,
		});
		expect(closed.activations).toEqual([
			{
				...activation('message:4:assistant:1', 1, 'respond', {
					status: 'failed',
					cause: 'transient',
				}),
				usage: spent(10, 0.5),
			},
			{
				...activation('message:4:assistant:2', 2, 'respond', { status: 'released' }),
				usage: spent(20, 0.25),
			},
			{
				...activation('closed:4:assistant:1', 1, 'summary', { status: 'revoked' }),
				usage: spent(5),
			},
		]);
		expect((await read(6))?.exchange.activations).toEqual([
			expect.objectContaining({ id: 'message:6:assistant:1', outcome: { status: 'released' } }),
			expect.objectContaining({ id: 'message:6:assistant:2', outcome: { status: 'running' } }),
		]);
	});
});

it('marks an activation a cancellation ended', () => {
	expect(
		exchangeActivation({
			id: 'message:4:assistant:1',
			phase: 'ended',
			at,
			claimedAt: at,
			since: 5,
			readThrough: 0,
			reason: 'revoked',
			cancelled: true,
			until: 6,
		}).outcome,
	).toEqual({ status: 'revoked', cancelled: true });
});

it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
	'rejects invalid exchange reference %s',
	async (from) => {
		await expect(
			readExchange(roomName('exchange-read-invalid'), from, { runtime: createRuntime() }),
		).rejects.toThrow(/positive safe integer/i);
	},
);
