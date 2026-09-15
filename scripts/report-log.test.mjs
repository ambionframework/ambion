import { strict as assert } from 'node:assert';
import test from 'node:test';
import { attemptOf, foldLeases, invalidRows, rowsOf, runsOf, writerOf } from './report-log.mjs';

const native = [
	{
		position: 0,
		entry: { kind: 'run', body: { at: '2026-09-14T00:00:00.000Z' }, seq: 1, run: 'r1' },
	},
	{
		position: 1,
		entry: {
			kind: 'lease',
			body: {
				id: 'message:1:alpha:1',
				phase: 'running',
				expiresAt: 100,
				at: '2026-09-14T00:00:01.000Z',
				readThrough: 1,
			},
			seq: 2,
			run: 'r1',
		},
	},
	{
		position: 2,
		entry: {
			kind: 'run',
			body: { at: '2026-09-14T00:00:02.000Z' },
			seq: 3,
			run: 'r2',
		},
	},
	{
		position: 3,
		entry: {
			kind: 'lease',
			body: {
				id: 'message:1:alpha:1',
				phase: 'ended',
				reason: 'expired',
				at: '2026-09-14T00:00:03.000Z',
				readThrough: 1,
			},
			seq: 4,
			run: 'r2',
		},
	},
	// A terminal lease change is ignored by the core fold and must not replace
	// the ended-by provenance used by the report.
	{
		position: 4,
		entry: {
			kind: 'lease',
			body: {
				id: 'message:1:alpha:1',
				phase: 'ended',
				reason: 'released',
				at: '2026-09-14T00:00:04.000Z',
				readThrough: 1,
			},
			seq: 5,
			run: 'r3',
		},
	},
];

test('reads native envelopes and preserves run provenance through terminal lease folds', () => {
	assert.equal(rowsOf(native, 'lease').length, 3);
	assert.deepEqual(runsOf(native), ['r1', 'r2']);
	assert.equal(writerOf(runsOf(native), rowsOf(native, 'lease')[0]), 1);
	const [lease] = foldLeases(native);
	assert.equal(lease.reason, 'expired');
	assert.equal(lease.readThrough, 1);
	assert.equal(lease.claimedBy, 'run 1');
	assert.equal(lease.endedBy, 'run 2');
	assert.equal(lease.crossed, true);
	assert.equal(lease.attempt, 1);
});

test('marks malformed native rows and activation ids invalid', () => {
	assert.equal(attemptOf('closed:12:alpha:3'), 3);
	assert.equal(attemptOf('close:12:3'), undefined);
	const badLease = {
		position: 5,
		entry: {
			kind: 'lease',
			body: {
				id: 'legacy:1:alpha',
				phase: 'ended',
				reason: 'refused',
				at: '2026-09-14T00:00:05.000Z',
				readThrough: 1,
			},
			seq: 6,
			run: 'r2',
		},
	};
	assert.equal(
		foldLeases([...native, badLease]).find((lease) => lease.id === 'legacy:1:alpha').invalidId,
		true,
	);
	const malformed = [
		...native,
		{ position: 5, entry: { kind: 'message', body: {}, seq: 0 } },
		{ position: 5, entry: { kind: 'message', body: {}, seq: 6 } },
		{ position: 7, nope: true },
	];
	assert.equal(invalidRows(malformed).length, 3);
});
