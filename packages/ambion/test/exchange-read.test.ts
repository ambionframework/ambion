import type { JournalOpener, JournalStorage } from '@ambionframework/journal';
import { describe, expect, it } from 'vitest';
import { pi, piExecution } from '../../pi/src/index.ts';
import { createRuntime, defineAgent, defineHuman, readExchange, startRoom } from '../src/index.ts';
import { deferred, roomName, tick, waitForRoom } from './support/room.ts';
import { contextText, quiet, scripted } from './support/scripted.ts';
import { storages } from './support/storage.ts';

const at = '2026-01-01T00:00:00.000Z';
const run = 'exchange-read-run';
const firstFrom = 4;

const composition = {
	version: 2 as const,
	goal: 'Keep the record coherent.',
	agents: [{ name: 'assistant', identity: 'Assistant.', attention: 'none' as const }],
	available: [],
	at,
};

const record = [
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
		body: { kind: 'said', at, from: 'priya', text: 'First question?', wakes: ['assistant'] },
		seq: firstFrom,
		run,
	},
	{
		kind: 'close',
		body: { owner: 'priya', from: firstFrom, through: firstFrom, at, summary: 'assistant' },
		seq: 5,
		run,
	},
	{
		kind: 'message',
		body: { kind: 'said', at, from: 'priya', text: 'Second question?' },
		seq: 6,
		run,
	},
	{
		kind: 'message',
		body: {
			kind: 'summary',
			at,
			from: 'assistant',
			to: 'priya',
			text: 'First answer.',
			covers: { from: firstFrom, through: firstFrom },
		},
		seq: 7,
		run,
	},
	// An administrative entry advances the journal without becoming a message.
	{ kind: 'run', body: { at }, seq: 8, run },
] as const;

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

async function seeded(storage: (typeof storages)[number], prefix: string) {
	const opened = await storage.open();
	const name = roomName(prefix);
	await appendRecord(opened.journals, name, record);
	const runtime = createRuntime({
		storage: opened.storage,
		clock: { now: () => 0, alarm: () => () => {} },
	});
	return { name, opened, runtime };
}

describe.each(storages)('readExchange on $name storage', (storage) => {
	it('reads an open exchange immediately while the live wait remains pending', async () => {
		const opened = await storage.open();
		const started = deferred();
		const release = deferred();
		const agent = defineAgent({
			name: 'worker',
			identity: 'Holds work.',
			executor: pi({ instructions: 'Wait for the test.', model: 'scripted/worker' }),
		});
		const runtime = createRuntime({
			storage: opened.storage,
			clock: { now: () => 0, alarm: () => () => {} },
		});
		const room = await startRoom({
			name: roomName(`exchange-read-open-${storage.name}`),
			runtime,
			agents: [agent],
			execution: piExecution({
				stream: scripted(async (context) => {
					if (!contextText(context).includes('What is open?')) return quiet();
					started.resolve();
					await release.promise;
					return quiet();
				}),
			}),
		});
		try {
			const person = defineHuman({ name: 'priya', identity: 'Project manager.' });
			const visit = await room.visit(person);
			await waitForRoom(room, 'settled');
			const handle = await visit.send({ text: 'What is open?' });
			await started.promise;

			const read = await readExchange(room.name, handle.from, { runtime });
			expect(read?.exchange).toMatchObject({ status: 'open', from: handle.from });
			expect(read?.messages.map((message) => message.seq)).toEqual([handle.from]);

			let closed = false;
			const waiting = handle.waitForClose().then(() => {
				closed = true;
			});
			await tick();
			expect(closed).toBe(false);
			release.resolve();
			await waiting;
		} finally {
			release.resolve();
			await room.stop();
			await opened.dispose();
		}
	});

	it('reads a stopped open record without appending or executing work', async () => {
		const { name, opened, runtime } = await seeded(
			storage,
			`exchange-read-stopped-${storage.name}`,
		);
		try {
			const before = await (await opened.journals.open(name)).read(0);
			const read = await readExchange(name, 6, { runtime });
			const after = await (await opened.journals.open(name)).read(0);
			expect(read?.exchange).toEqual({
				status: 'open',
				owner: 'priya',
				from: 6,
				at,
			});
			expect(read?.messages.map((message) => message.seq)).toEqual([6]);
			expect(after.position).toBe(before.position);
		} finally {
			await opened.dispose();
		}
	});

	it('returns the fixed discussion and published summary for a closed exchange', async () => {
		const { name, opened, runtime } = await seeded(storage, `exchange-read-closed-${storage.name}`);
		try {
			const result = await readExchange(name, firstFrom, { runtime });
			if (result === undefined || result.exchange.status !== 'closed')
				throw new Error('Expected the first exchange to be closed.');
			expect(result.messages.map((message) => message.seq)).toEqual([firstFrom]);
			expect(result.messages.every((message) => message.kind !== 'summary')).toBe(true);
			expect(result.exchange.summary).toMatchObject({
				status: 'published',
				summary: { text: 'First answer.', covers: { from: firstFrom, through: firstFrom } },
			});
			// The late summary follows the opening of the next exchange, but stays with its close.
			const later = await readExchange(name, 6, { runtime });
			expect(later?.exchange).toMatchObject({ status: 'open', from: 6 });
			expect(later?.messages.map((message) => message.seq)).toEqual([6]);
			expect(result.watermark).toBe(8);
		} finally {
			await opened.dispose();
		}
	});

	it('returns undefined for interior positions, missing exchanges, and missing rooms', async () => {
		const { name, opened, runtime } = await seeded(
			storage,
			`exchange-read-missing-${storage.name}`,
		);
		try {
			expect(await readExchange(name, 3, { runtime })).toBeUndefined();
			expect(await readExchange(name, 5, { runtime })).toBeUndefined();
			expect(await readExchange(name, 7, { runtime })).toBeUndefined();
			expect(await readExchange(roomName('exchange-read-absent'), 1, { runtime })).toBeUndefined();
		} finally {
			await opened.dispose();
		}
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects invalid exchange reference %s',
		async (from) => {
			const opened = await storage.open();
			const runtime = createRuntime({ storage: opened.storage });
			try {
				await expect(
					readExchange(roomName(`exchange-read-invalid-${storage.name}`), from, { runtime }),
				).rejects.toThrow(/positive safe integer/i);
			} finally {
				await opened.dispose();
			}
		},
	);

	it('detaches nested discussion and summary values on every read', async () => {
		const { name, opened, runtime } = await seeded(
			storage,
			`exchange-read-detached-${storage.name}`,
		);
		try {
			const first = await readExchange(name, firstFrom, { runtime });
			if (first === undefined || first.exchange.status !== 'closed')
				throw new Error('Expected a closed exchange.');
			const message = first.messages[0];
			if (message === undefined || message.kind !== 'said')
				throw new Error('Expected the opening message.');
			message.wakes?.push('mutated');
			if (first.exchange.summary.status !== 'published')
				throw new Error('Expected a published summary.');
			first.exchange.summary.summary.covers.from = 99;
			first.exchange.summary.summary.text = 'mutated';

			const again = await readExchange(name, firstFrom, { runtime });
			if (again === undefined || again.exchange.status !== 'closed')
				throw new Error('Expected a closed exchange.');
			const original = again.messages[0];
			expect(original?.kind === 'said' ? original.wakes : undefined).toEqual(['assistant']);
			expect(again.exchange.summary).toMatchObject({
				status: 'published',
				summary: { text: 'First answer.', covers: { from: firstFrom, through: firstFrom } },
			});
		} finally {
			await opened.dispose();
		}
	});
});
