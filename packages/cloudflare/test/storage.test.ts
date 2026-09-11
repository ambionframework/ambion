/**
 * Pi's session over the object's SQLite: an entry appended is an entry
 * replayed, in order, on the lane it was appended to, and every row is
 * plain JSON.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { assertWire, roundTrip } from '@ambionframework/ambion';
import { expect, it } from 'vitest';
import { sqlSessions } from '../src/storage.ts';

it("appends and replays entries through the object's SQLite", async () => {
	const stub = env.ROOM.get(env.ROOM.idFromName('storage'));
	await runInDurableObject(stub, async (_instance, state) => {
		const sessions = sqlSessions(state);
		const first = await sessions.open('site');
		await first.appendCustomEntry('ambion/message', {
			kind: 'said',
			seq: 1,
			from: 'priya',
			text: 'hi',
		});
		await first.appendMessage({ role: 'user', content: 'a turn', timestamp: 1 });
		await first.appendCustomEntry('ambion/lease', {
			id: '1:product',
			phase: 'running',
			expiry: 2,
			after: 1,
		});

		// a second open reads the same session, with the same entries in order
		const again = await sessions.open('site');
		const entries = await again.findEntries();
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
		expect(entries.map((e) => e.type)).toEqual(['custom', 'message', 'custom']);
		expect(entries.map((e) => e.parentId)).toEqual([null, entries[0]?.id, entries[1]?.id]);
		expect(await again.findEntries({ customType: 'ambion/lease' })).toHaveLength(1);
		expect(await again.findEntries({ order: 'newestFirst', limit: 1 })).toMatchObject([{ seq: 3 }]);
		for (const entry of entries) {
			expect(() => assertWire(entry)).not.toThrow();
			expect(roundTrip(entry)).toStrictEqual(entry);
		}
		expect((await again.getMetadata()).id).toBe('site');

		// a child session names its parent, and lives beside it in the same storage
		const child = await sessions.open('site:product', 'site');
		expect((await child.getMetadata()).parentSessionId).toBe('site');
		expect(await child.findEntries()).toEqual([]);
	});
});
