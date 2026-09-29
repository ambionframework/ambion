/**
 * The position one activation read through. The executor reports each range
 * the model consumed, and the core joins the ranges into the position read.
 * A range that lands out of order waits until the gap closes. A tool result
 * that carries record counts once it reaches the model.
 */
import { expect, it } from 'vitest';
import { Freshness } from '../src/execution/freshness.ts';

it.each([
	['the initial view', [[0, 3]], 3],
	['nothing, before a range', [], 0],
	[
		'a range that does not join, while the gap stays open',
		[
			[0, 1],
			[3, 4],
		],
		1,
	],
	[
		'a range that waited for its gap, once the gap closes',
		[
			[3, 4],
			[0, 3],
		],
		4,
	],
	[
		'a range seen twice, once',
		[
			[0, 2],
			[0, 2],
		],
		2,
	],
	[
		'ranges that both join, the lowest first',
		[
			[0, 3],
			[0, 2],
			[2, 5],
		],
		5,
	],
	[
		'a range below the position read, as nothing',
		[
			[0, 5],
			[0, 3],
		],
		5,
	],
] as const)('reads %s', (_name, ranges, through) => {
	const freshness = new Freshness();
	for (const [after, to] of ranges) freshness.consumedRange({ after, through: to });
	expect(freshness.readThrough).toBe(through);
});

it('never moves back, and a say does not join a range that waits', () => {
	const freshness = new Freshness();
	freshness.acknowledgeThrough(5);
	freshness.acknowledgeThrough(4);
	expect(freshness.readThrough).toBe(5);
	freshness.consumedRange({ after: 6, through: 7 });
	freshness.acknowledgeThrough(6);
	expect(freshness.readThrough).toBe(6);
	freshness.consumedRange({ after: 6, through: 7 });
	expect(freshness.readThrough).toBe(7);
});

it('advances on a delivered tool result only for the call that expects it, once', () => {
	const freshness = new Freshness();
	freshness.resultExpected('call-1', 4);
	freshness.delivered('call-2');
	expect(freshness.readThrough).toBe(0);
	freshness.consumedRange({ after: 4, through: 6 });
	freshness.delivered('call-1');
	// The result closes the gap, so the range that waited joins.
	expect(freshness.readThrough).toBe(6);
	freshness.resultExpected('call-3', 2);
	freshness.delivered('call-3');
	freshness.delivered('call-3');
	expect(freshness.readThrough).toBe(6);
});
