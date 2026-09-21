/**
 * The room's routing rule, over what it is handed. `routes` decides who a
 * message wakes, and the verified `wakes` inside it is the one comparison it
 * reads off the attention scale. It is pure, so every test here hands it a
 * value.
 *
 * What the rule does inside a running room is `roster.test.ts` and
 * `presence.test.ts`; this file holds the rule itself.
 */
import { describe, expect, it } from 'vitest';
import type { RoomState } from '../src/room/fold.ts';
import { routes } from '../src/room/routing.ts';
import type { Attention, Message } from '../src/types.ts';

describe('what a message reaches', () => {
	const at = '2026-01-01T09:00:00.000Z';
	// One seat on the roster, and what `routes` answers for it.
	const wakes = (who: { name: string; attention: Attention }, message: Message) =>
		routes(
			message,
			{ roster: [{ ...who, identity: 'Seat.' }], messages: [], closes: [] } as unknown as RoomState,
			new Map(),
		).includes(who.name);
	const seat = (name: string, attention: Attention) => ({ name, attention });
	const said = (to?: string): Message => ({
		kind: 'said',
		seq: 2,
		at,
		from: 'priya',
		text: 'go',
		...(to === undefined ? {} : { to }),
	});
	const summary: Message = {
		kind: 'summary',
		seq: 3,
		at,
		from: 'assistant',
		to: 'priya',
		text: 'What happened.',
		covers: { from: 2, through: 2 },
	};

	it('wakes a seat whose attention is at least as wide as the message', () => {
		expect(wakes(seat('product', 'broadcast'), said())).toBe(true);
		expect(wakes(seat('product', 'named'), said())).toBe(false);
		// a directed say reaches the one it names, however narrowly it is seated
		expect(wakes(seat('product', 'none'), said('product'))).toBe(true);
		expect(wakes(seat('other', 'presence'), said('product'))).toBe(false);
	});

	it('wakes nobody for a summary, however wide the seat is seated', () => {
		// A summary is written for one person over a range the room has closed:
		// it is news to nobody in the room. A seat woken by it would read a
		// message about itself and answer it, and the room would never settle.
		for (const attention of ['none', 'named', 'broadcast', 'presence'] as const) {
			expect(wakes(seat('product', attention), summary)).toBe(false);
		}
	});

	it('wakes a seat occupied by closing work for a later ordinary exchange', () => {
		const state = {
			roster: [{ name: 'writer', identity: 'Writer.', attention: 'broadcast' }],
			messages: [],
			people: new Map(),
			closes: [{ owner: 'priya', from: 1, through: 3, at, summary: 'writer' }],
		} as unknown as RoomState;
		expect(
			routes({ ...said(), seq: 4 }, state, new Map([['writer', ['closed:3:writer:1']]])),
		).toEqual(['writer']);
	});

	it('ignores a stale ordinary lease after removal and reseating', () => {
		const state = {
			roster: [{ name: 'writer', identity: 'Writer.', attention: 'broadcast' }],
			messages: [
				{ ...said(), seq: 2 },
				{ kind: 'unseated', seq: 3, at, subject: 'writer' },
				{
					kind: 'seated',
					seq: 4,
					at,
					subject: 'writer',
					identity: 'Writer.',
					attention: 'broadcast',
				},
			],
			closes: [],
		} as unknown as RoomState;
		expect(
			routes({ ...said(), seq: 5 }, state, new Map([['writer', ['message:2:writer:1']]])),
		).toEqual(['writer']);
	});
});
