/**
 * Native journals use one SQLite table through distinct names.
 * Each keeps its own ordering and replay contract.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { namespaced } from '@ambionframework/journal';
import { storageConformance } from '@ambionframework/journal/conformance';
import { expect, it } from 'vitest';
import { roomMetadata, seatMetadata, sqlStorage } from '../src/storage.ts';

it('orders native journal appends conditionally beside a second journal name on one backend', async () => {
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

		const other = await namespaced(storage, 'ambion/other').open('room');
		await other.append({ step: 1 }, 0);
		expect((await first.read(0)).entries).toEqual(read.entries);
		expect((await other.read(0)).entries).toHaveLength(1);
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
			patch: { name: 'room', agents: ['assistant'], stopped: false },
		}));
		expect(await metadata.read()).toEqual({
			name: 'room',
			agents: ['assistant'],
			stopped: false,
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

// The cases run inside the object, where the SQLite storage lives. Each case
// builds its suite in place, so the journal names it mints stay its own.
const listed = storageConformance({
	open: () => {
		throw new Error('The listing opens no storage.');
	},
});
for (const [index, c] of listed.entries()) {
	it(`durable object SQLite ${c.name}`, async () => {
		const stub = env.ROOM.get(env.ROOM.idFromName('storage-conformance'));
		await runInDurableObject(stub, async (_instance, state) => {
			const suite = storageConformance({ open: () => ({ opener: sqlStorage(state) }) });
			await suite[index]?.run();
		});
	});
}
