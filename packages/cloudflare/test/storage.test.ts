/**
 * Native journals use one SQLite table through distinct names. Each keeps
 * its own ordering and replay contract. The durable record of each object
 * lives in a table beside them.
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

it('keeps each object record in one row, and applies each change whole', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage-metadata'));
	await runInDurableObject(stub, async (_instance, state) => {
		const room = roomMetadata(state);
		expect(room.read()).toEqual({});
		expect(room.change(() => undefined)).toEqual({});
		room.change(() => ({ patch: { name: 'room', agents: ['assistant'], stopped: false } }));
		expect(room.change(() => ({ remove: ['stopped'] }))).toEqual({
			name: 'room',
			agents: ['assistant'],
		});
		// A copy leaves the stored record as it was.
		room.read().agents?.push('extra');
		expect(roomMetadata(state).read()).toEqual({ name: 'room', agents: ['assistant'] });

		// A second store over the same object reads what the first wrote, and
		// the seat record keeps a row apart from the room record.
		const seat = seatMetadata(state);
		const other = seatMetadata(state);
		await Promise.all(
			Array.from({ length: 8 }, async (_, index) =>
				(index % 2 === 0 ? seat : other).change((current) => ({
					patch: { wakes: (current.wakes ?? 0) + 1 },
				})),
			),
		);
		expect(seat.read()).toEqual({ wakes: 8 });
		expect(room.read()).toEqual({ name: 'room', agents: ['assistant'] });
		const rows = state.storage.sql.exec('SELECT name FROM ambion_metadata ORDER BY name').toArray();
		expect(rows.map((row) => row.name)).toEqual(['room', 'seat']);
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
