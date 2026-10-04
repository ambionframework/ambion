import { expect, it } from 'vitest';
import { isRoomName } from '../src/names.ts';

it.each<[string, boolean]>([
	['a', true],
	['site-office9', true],
	['a'.repeat(48), true],
	['a'.repeat(49), false],
	['', false],
	['Alpha', false],
	['9lives', false],
	['alpha_beta', false],
	...['\n', '\r', '\r\n', '\u2028', '\u2029'].map((end): [string, boolean] => [
		`alpha${end}`,
		false,
	]),
])('checks the room syntax and 48-character limit: %j', (name, valid) => {
	expect(isRoomName(name)).toBe(valid);
});
