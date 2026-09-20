import { describe, expect, it } from 'vitest';
import { AmbionError, exchangeUri, parseRoomUri, roomUri } from '../src/index.ts';
import { isRef, REF_LIMITS, refsRefusal } from '../src/refs.ts';

describe('room URIs', () => {
	it('round-trips a room and an exchange', () => {
		expect(roomUri('site')).toBe('ambion://room/site');
		expect(exchangeUri('site', 12)).toBe('ambion://room/site/exchange/12');
		expect(parseRoomUri(roomUri('site'))).toEqual({ room: 'site' });
		expect(parseRoomUri(exchangeUri('site', 12))).toEqual({ room: 'site', exchange: 12 });
	});

	it.each([
		'ambion://room/Site',
		'ambion://room/site/exchange/0',
		'ambion://room/site/exchange/01',
		'ambion://room/site/exchange/1.5',
		'ambion://room/site/exchange/9007199254740993',
		'ambion://room/site/',
		'ambion://room/site?x=1',
		'ambion://room/site#top',
		'AMBION://room/site',
		'ambion://room/site/exchange/1/extra',
		'ambion://room/',
	])('refuses %s', (uri) => {
		expect(parseRoomUri(uri)).toBeUndefined();
	});

	it('refuses a bad name or a bad seq when it builds', () => {
		expect(() => roomUri('Site')).toThrow(AmbionError);
		expect(() => exchangeUri('site', 0)).toThrow(RangeError);
		expect(() => exchangeUri('site', 1.5)).toThrow(RangeError);
	});
});

describe('refs', () => {
	it.each([
		'https://x/y',
		's3://b/k',
		'file:///a',
		'mailto:a@b',
		'ambion://room/site',
		'ambion://room/site/exchange/12',
	])('accepts %s', (ref) => {
		expect(isRef(ref)).toBe(true);
	});

	it.each([
		'shared/report.md',
		'https://x/a b',
		'https://x/a\nb',
		'https://x/a\u0000b',
		`https://${'x'.repeat(REF_LIMITS.length)}`,
		'ambion:',
		'ambion://room/Site',
		'Ambion://room/site',
	])('refuses %j', (ref) => {
		expect(isRef(ref)).toBe(false);
	});

	it('refuses a list that breaks a rule and accepts an empty one', () => {
		expect(refsRefusal([])).toBeUndefined();
		expect(refsRefusal(['https://x/a', 'https://x/b'])).toBeUndefined();
		expect(refsRefusal('https://x/a')).toMatch(/array/);
		expect(refsRefusal([1])).toMatch(/refs\[0\]/);
		expect(refsRefusal(['https://x/a', 'https://x/a'])).toMatch(/refs\[1\]/);
		const many = Array.from({ length: REF_LIMITS.count + 1 }, (_, i) => `https://x/${i}`);
		expect(refsRefusal(many)).toMatch(/17 entries/);
	});
});
