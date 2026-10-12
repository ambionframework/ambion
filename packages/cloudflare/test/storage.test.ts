/**
 * Native journals use one SQLite table through distinct names. Each keeps
 * its own ordering and replay contract. The durable record of each object
 * lives in a table beside them.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { storageConformance } from '@ambionframework/journal/conformance';
import { expect, it } from 'vitest';
import { roomMetadata, seatMetadata, sqlStorage } from '../src/storage.ts';

it('keeps each object record in one row, and applies each change whole', async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage-metadata'));
	await runInDurableObject(stub, async (_instance, state) => {
		const room = roomMetadata(state);
		expect(room.read()).toEqual({});
		expect(room.change(() => undefined)).toEqual({});
		expect(room.change(() => ({ patch: { stopped: true } }))).toEqual({ stopped: true });
		// A copy leaves the stored record as it was.
		room.read().stopped = false;
		expect(roomMetadata(state).read()).toEqual({ stopped: true });
		expect(room.change(() => ({ remove: ['stopped'] }))).toEqual({});
		room.change(() => ({ patch: { stopped: true } }));

		// A second store over the same object reads what the first wrote, and
		// the seat record keeps a row apart from the room record.
		const seat = seatMetadata(state);
		const other = seatMetadata(state);
		await Promise.all(
			Array.from({ length: 8 }, async (_, index) =>
				(index % 2 === 0 ? seat : other).change((current) => ({
					patch: { activation: `${current.activation ?? ''}x` },
				})),
			),
		);
		expect(seat.read()).toEqual({ activation: 'xxxxxxxx' });
		expect(room.read()).toEqual({ stopped: true });
		const rows = state.storage.sql.exec('SELECT name FROM ambion_metadata ORDER BY name').toArray();
		expect(rows.map((row) => row.name)).toEqual(['room', 'seat']);
	});
});

// The cases run inside the object, where the SQLite storage lives. Each case
// builds its suite in place, so the journal names it mints stay its own.
const listed = storageConformance({
	name: 'durable object SQLite',
	open: () => {
		throw new Error('The listing opens no storage.');
	},
});
for (const [index, c] of listed.entries()) {
	it(`durable object SQLite ${c.name}`, async () => {
		const stub = env.ROOM.get(env.ROOM.idFromName('storage-conformance'));
		await runInDurableObject(stub, async (_instance, state) => {
			const suite = storageConformance({
				name: 'durable object SQLite',
				open: () => ({ opener: sqlStorage(state), peer: () => sqlStorage(state) }),
			});
			await suite[index]?.run();
		});
	});
}
