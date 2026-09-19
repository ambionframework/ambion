import { describe, expect, it } from 'vitest';
import { ellipsize } from '../src/text.ts';

describe('ellipsize', () => {
	it('returns text that already fits, with its spaces collapsed', () => {
		expect(ellipsize('Blink one LED', 40)).toBe('Blink one LED');
		expect(ellipsize('  Blink \n one\tLED  ', 40)).toBe('Blink one LED');
	});

	it('keeps text that is exactly as wide as the line', () => {
		expect(ellipsize('abcde', 5)).toBe('abcde');
	});

	it('ends at a word edge when one is near the cut', () => {
		expect(ellipsize('Choose a series resistor and confirm the current', 30)).toBe(
			'Choose a series resistor and…',
		);
	});

	it('never exceeds the width', () => {
		const text = 'Bring up an Arduino Uno with one blinking LED. Choose a series resistor.';
		for (let width = 1; width < text.length; width += 1)
			expect(ellipsize(text, width).length).toBeLessThanOrEqual(width);
	});

	it('cuts inside a long word when no word edge is near', () => {
		expect(ellipsize('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 10)).toBe('aaaaaaaaa…');
		expect(ellipsize('ab cdefghijklmnopqrstuvwxyzabcdefghijkl', 30)).toBe(
			'ab cdefghijklmnopqrstuvwxyzab…',
		);
	});

	it('returns only the ellipsis for a one-cell line, and nothing for no cells', () => {
		expect(ellipsize('goal', 1)).toBe('…');
		expect(ellipsize('goal', 0)).toBe('');
		expect(ellipsize('goal', -3)).toBe('');
	});
});
