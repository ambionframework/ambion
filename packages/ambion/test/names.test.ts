import { expect, it } from 'vitest';
import { isName } from '../src/names.ts';

it.each(['a', 'alpha', 'site-office9', 'a-', 'a'.repeat(49), 'a'.repeat(1_000)])(
	'accepts a complete name without a length limit: %s',
	(name) => expect(isName(name)).toBe(true),
);

it.each([
	'',
	'Alpha',
	'9lives',
	'-alpha',
	'alpha_beta',
	'alpha.beta',
	'álpha',
	' alpha',
	'alpha ',
	'alpha/beta',
	'alpha:beta',
	...['\n', '\r', '\r\n', '\u2028', '\u2029'].flatMap((end) => [
		`${end}alpha`,
		`alpha${end}`,
		`alpha${end}beta`,
	]),
	undefined,
	null,
	12,
	{ toString: () => 'alpha' },
])('rejects a value outside the complete name syntax: %j', (value) => {
	expect(isName(value)).toBe(false);
});
