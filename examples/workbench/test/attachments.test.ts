import { describe, expect, it } from 'vitest';
import { pastedImagePath } from '../src/attachments.ts';

describe('pastedImagePath', () => {
	it.each([
		[
			'an absolute picture path',
			'/Users/andrei/Pictures/board.png',
			'/Users/andrei/Pictures/board.png',
		],
		['a ~/ picture path', '~/Downloads/photo.jpg', '~/Downloads/photo.jpg'],
		[
			'a path in the whitespace bracketed paste carries',
			'  /home/scribe/photo.png\n',
			'/home/scribe/photo.png',
		],
	])('names %s', (_case, pasted, path) => {
		expect(pastedImagePath(pasted)).toBe(path);
	});

	it.each([
		['a relative path, since /attach takes only an absolute or ~/ one', 'Pictures/board.png'],
		['a path with no picture extension', '/home/scribe/notes.txt'],
		['a multi-line paste', '/home/scribe/photo.png\nand another line'],
		['a path that holds a space', '/Users/andrei/My Pictures/board.png'],
		['a pasted sentence', 'Look at /home/scribe/photo.png for the board.'],
		['an empty paste', ''],
		['a blank paste', '   '],
	])('names none of %s', (_case, pasted) => {
		expect(pastedImagePath(pasted)).toBeUndefined();
	});
});
