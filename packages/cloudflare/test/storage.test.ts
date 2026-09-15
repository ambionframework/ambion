/**
 * Native journals and Pi transcripts use one SQLite table through distinct
 * names. Each keeps its own ordering and replay contract.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { assertWire, roundTrip } from '@ambionframework/ambion/transport';
import { namespaced } from '@ambionframework/journal';
import { piSessions } from '@ambionframework/journal/pi';
import { expect, it } from 'vitest';
import { roomMetadata, seatMetadata, sqlStorage } from '../src/storage.ts';

it("appends and replays Pi transcript entries through the object's SQLite", async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage'));
	await runInDurableObject(stub, async (_instance, state) => {
		const transcripts = piSessions(sqlStorage(state));
		const first = await transcripts.open('site');
		await first.appendCustomEntry('audit/activation', { seat: 'product' });
		await first.appendMessage({ role: 'user', content: 'a turn', timestamp: 1 });
		await first.appendCustomEntry('audit/lease', { id: 'message:1:product:1', phase: 'running' });

		const again = await transcripts.open('site');
		const entries = await again.findEntries({ order: 'oldestFirst' });
		expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
		expect(entries.map((entry) => entry.type)).toEqual(['custom', 'message', 'custom']);
		expect(entries.map((entry) => entry.parentId)).toEqual([null, entries[0]?.id, entries[1]?.id]);
		expect(await again.findEntries({ customType: 'audit/lease' })).toHaveLength(1);
		expect(await again.findEntries({ order: 'newestFirst', limit: 1 })).toMatchObject([{ seq: 3 }]);
		for (const entry of entries) {
			expect(() => assertWire(entry)).not.toThrow();
			expect(roundTrip(entry)).toStrictEqual(entry);
		}
		expect((await again.getMetadata()).id).toBe('site');

		const child = await transcripts.open('site:product', 'site');
		expect((await child.getMetadata()).parentSessionId).toBe('site');
		expect(await child.findEntries()).toEqual([]);
	});
});

it('orders native journal appends conditionally beside Pi transcripts on one backend', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage-conditional'));
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = sqlStorage(state);
		const journals = namespaced(storage, 'ambion/room');
		const first = await journals.open('room');
		const second = await journals.open('room');
		const [left, right] = await Promise.all([
			first.append({ writer: 'left' }, 0),
			second.append({ writer: 'right' }, 0),
		]);
		expect([left, right].filter((entry) => entry !== undefined)).toHaveLength(1);
		const read = await first.read(0);
		expect(read.position).toBe(1);
		expect(read.entries).toHaveLength(1);

		const transcripts = piSessions(storage);
		const transcript = await transcripts.open('room');
		await transcript.appendMessage({ role: 'user', content: 'audit', timestamp: 1 });
		expect((await first.read(0)).entries).toEqual(read.entries);
		expect(await transcript.findEntries()).toHaveLength(1);
	});
});

it('keeps an atomic metadata patch after an uncertain append confirmation', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage-metadata'));
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = sqlStorage(state);
		let loseConfirmation = true;
		const uncertain = {
			open: async (name: string) => {
				const journal = await storage.open(name);
				return {
					read: (after: number) => journal.read(after),
					async append(entry: unknown, position: number) {
						const appended = await journal.append(entry, position);
						if (appended !== undefined && loseConfirmation) {
							loseConfirmation = false;
							throw new Error('the write landed but the confirmation did not');
						}
						return appended;
					},
				};
			},
		};
		const metadata = roomMetadata(uncertain);
		await metadata.change(() => ({
			patch: { name: 'room', people: { priya: { name: 'priya', identity: 'Manager.' } } },
		}));
		expect(await metadata.read()).toEqual({
			name: 'room',
			people: { priya: { name: 'priya', identity: 'Manager.' } },
		});
		const entries = await (
			await namespaced(storage, 'ambion/cloudflare/room').open('metadata')
		).read(0);
		expect(entries.entries).toHaveLength(1);

		const seat = seatMetadata(storage);
		await Promise.all(
			Array.from({ length: 8 }, () =>
				seat.change((current) => ({ patch: { wakes: (current.wakes ?? 0) + 1 } })),
			),
		);
		expect((await seat.read()).wakes).toBe(8);
	});
});

it('refreshes metadata from the cursor after confirmed patches', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage-metadata-cursor'));
	await runInDurableObject(stub, async (_instance, state) => {
		const storage = sqlStorage(state);
		const after: number[] = [];
		const counted = {
			async open(name: string) {
				const journal = await storage.open(name);
				return {
					async read(position: number) {
						after.push(position);
						return journal.read(position);
					},
					append: journal.append.bind(journal),
				};
			},
		};
		const metadata = roomMetadata(counted);
		await metadata.change(() => ({ patch: { name: 'first' } }));
		await metadata.change(() => ({ patch: { name: 'second' } }));
		await metadata.change(() => ({ patch: { name: 'third' } }));
		expect(await metadata.read()).toEqual({ name: 'third' });
		expect(after).toEqual([0, 1, 2, 3]);
	});
});
