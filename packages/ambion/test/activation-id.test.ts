import { describe, expect, it } from 'vitest';
import { type ActivationId, decodeActivationId, encodeActivationId } from '../src/activation-id.ts';

describe('activation id codec', () => {
	it('round trips every stored source without changing its spelling', () => {
		for (const source of ['message', 'closed'] as const) {
			const value: ActivationId = { source, position: 42, seat: 'site-office', attempt: 3 };
			const raw = encodeActivationId(value);
			expect(raw).toBe(`${source}:42:site-office:3`);
			expect(decodeActivationId(raw)).toEqual(value);
		}
	});

	it.each([
		'message:0:alpha:1',
		'message:1:alpha:0',
		'message:01:alpha:1',
		'message:1:alpha:01',
		'message:9007199254740992:alpha:1',
		'message:1:alpha:9007199254740992',
		'message:1:alpha:1\n',
		'message:1:alpha:1\r\n',
		'message:1:Alpha:1',
		'message:1::1',
		'message:1:alpha',
		'unknown:1:alpha:1',
		'opened:1:alpha:1',
	])('rejects non-canonical id %s', (raw) => {
		expect(decodeActivationId(raw)).toBeUndefined();
	});

	it.each([
		{ position: 0 },
		{ seat: 'Alpha' },
		{ seat: 'alpha\n' },
		{ attempt: 0 },
		{ position: Number.MAX_SAFE_INTEGER + 1 },
	])('rejects an invalid value when encoding: %j', (change) => {
		const value: ActivationId = { source: 'message', position: 1, seat: 'alpha', attempt: 1 };
		expect(() => encodeActivationId({ ...value, ...change })).toThrow();
	});

	it('does not coerce non-string input at the protocol boundary', () => {
		expect(decodeActivationId(null)).toBeUndefined();
		expect(decodeActivationId({})).toBeUndefined();
	});
});
