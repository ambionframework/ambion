/**
 * What a participant reads of one message. `renderLine` is pure, so every
 * test here hands it a value.
 *
 * What the whole record reads like inside a running room is covered by the
 * context tests; this file holds the one line.
 */
import { describe, expect, it } from 'vitest';
import { renderLine } from '../src/seat/render.ts';
import type { Message } from '../src/types.ts';

describe('one line of the record', () => {
	const at = '2026-01-01T09:00:00.000Z';

	it('reads a say as its author, and names who it was directed at', () => {
		const said: Message = { kind: 'said', seq: 2, at, from: 'priya', text: 'Is the pour on?' };
		expect(renderLine(said)).toBe('[priya] Is the pour on?');
		expect(renderLine({ ...said, to: 'product' })).toBe('[priya → product] Is the pour on?');
	});

	it('reads a summary the way it reads anything addressed to one person', () => {
		const summary: Message = {
			kind: 'summary',
			seq: 6,
			at,
			from: 'writer',
			to: 'priya',
			text: 'Saturday.',
			covers: { from: 2, through: 4 },
		};
		expect(renderLine(summary)).toBe('[writer → priya] Saturday.');
	});

	it('names a presence author only where it differs from the subject', () => {
		// A person arrives by themselves, so the two names are one and the
		// line says it once: "priya arrived by priya" tells a reader nothing.
		const arrived: Message = { kind: 'arrived', seq: 1, at, from: 'priya', subject: 'priya' };
		expect(renderLine(arrived)).toBe('· priya arrived');
		expect(renderLine({ ...arrived, kind: 'left' })).toBe('· priya left');

		// An ordinary seat seated the surveyor, so the line names both.
		const seated: Message = {
			kind: 'seated',
			seq: 8,
			at,
			from: 'product',
			subject: 'surveyor',
			identity: 'Holds the tonnage.',
		};
		expect(renderLine(seated)).toBe('· surveyor seated by product');

		// The host seated it, and the host is not a participant: no author.
		const byHost: Message = { kind: 'seated', seq: 8, at, subject: 'surveyor' };
		expect(renderLine(byHost)).toBe('· surveyor seated');
		expect(renderLine({ ...byHost, kind: 'unseated' })).toBe('· surveyor unseated');
	});
});
