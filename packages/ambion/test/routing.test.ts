/**
 * The room's routing rule, over what it is handed. `routes` decides who a
 * message wakes; `wakes` is the one comparison it reads off the attention
 * scale. Both are pure, so every test here hands them a value.
 *
 * What the rule does inside a running room is `roster.test.ts` and
 * `presence.test.ts`; this file holds the rule itself.
 */
import { describe, expect, it } from 'vitest';
import { wakes } from '../src/room/routing.ts';
import type { Attention, Message } from '../src/types.ts';

describe('what a message reaches', () => {
	const at = '2026-01-01T09:00:00.000Z';
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
		expect(wakes(seat('product', 'broadcast'), undefined, said())).toBe(true);
		expect(wakes(seat('product', 'named'), undefined, said())).toBe(false);
		// a directed say reaches the one it names, however narrowly it is seated
		expect(wakes(seat('product', 'none'), 'product', said('product'))).toBe(true);
		expect(wakes(seat('other', 'presence'), 'product', said('product'))).toBe(false);
	});

	it('wakes nobody for a summary, however wide the seat is seated', () => {
		// A summary is written for one person over a range the room has closed:
		// it is news to nobody in the room. A seat woken by it would read a
		// message about itself and answer it, and the room would never settle.
		for (const attention of ['none', 'named', 'broadcast', 'presence'] as const) {
			expect(wakes(seat('product', attention), 'priya', summary)).toBe(false);
		}
	});
});
