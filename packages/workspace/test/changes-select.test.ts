import { describe, expect, it } from 'vitest';
import { select, type WorkspaceChange } from '../src/changes.ts';

function changeFor(tag: string, exchange?: { owner: string; from: number }): WorkspaceChange {
	return {
		time: new Date().toISOString(),
		room: 'lobby',
		agent: 'scribe',
		tool: 'write',
		...(exchange === undefined ? {} : { exchange }),
		paths: [`/home/scribe/${tag}.txt`],
	};
}

describe('select', () => {
	it('keeps entries of the exchange and drops entries with none', () => {
		const entries = [
			changeFor('a', { owner: 'andrei', from: 1 }),
			changeFor('b', { owner: 'andrei', from: 5 }),
			changeFor('c', { owner: 'priya', from: 1 }),
			changeFor('d'),
		];
		const chosen = select(entries, { exchange: { owner: 'andrei', from: 1 } });
		expect(chosen.map((entry) => entry.paths[0])).toEqual(['/home/scribe/a.txt']);
	});
});
