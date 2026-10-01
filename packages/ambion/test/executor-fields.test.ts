import { expect, it } from 'vitest';
import { contentText, pickPresent, present } from '../src/hosting.ts';

it('keeps the fields of an executor family that hold a value', () => {
	expect(present({ a: 1, b: undefined, c: 0, d: '' })).toEqual({ a: 1, c: 0, d: '' });
	const options = { mode: 'strict', limit: undefined, name: 'writer', extra: true };
	const fields = pickPresent(options, ['mode', 'limit', 'name']);
	expect(fields).toEqual({ mode: 'strict', name: 'writer' });
	expect(Object.keys(fields)).toEqual(['mode', 'name']);
});

it('joins the text parts of a tool result and skips an image', () => {
	expect(
		contentText([
			{ type: 'text', text: 'one ' },
			{ type: 'image', data: 'AAAA', mimeType: 'image/png' },
			{ type: 'text', text: 'two' },
		]),
	).toBe('one two');
});
