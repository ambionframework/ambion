import { describe, expect, it } from 'vitest';
import { pastedImagePath } from '../src/attachments.ts';

describe('pastedImagePath', () => {
	it('names an absolute picture path', () => {
		expect(pastedImagePath('/Users/andrei/Pictures/board.png')).toBe(
			'/Users/andrei/Pictures/board.png',
		);
	});

	it('names a ~/ picture path', () => {
		expect(pastedImagePath('~/Downloads/photo.jpg')).toBe('~/Downloads/photo.jpg');
	});

	it('trims the surrounding whitespace bracketed paste carries', () => {
		expect(pastedImagePath('  /home/scribe/photo.png\n')).toBe('/home/scribe/photo.png');
	});

	it('names none of a relative path, since /attach takes only an absolute or ~/ one', () => {
		expect(pastedImagePath('Pictures/board.png')).toBeUndefined();
	});

	it('names none of a path with no picture extension', () => {
		expect(pastedImagePath('/home/scribe/notes.txt')).toBeUndefined();
	});

	it('names none of a multi-line paste', () => {
		expect(pastedImagePath('/home/scribe/photo.png\nand another line')).toBeUndefined();
	});

	it('names none of a path that holds a space', () => {
		expect(pastedImagePath('/Users/andrei/My Pictures/board.png')).toBeUndefined();
	});

	it('names none of a pasted sentence', () => {
		expect(pastedImagePath('Look at /home/scribe/photo.png for the board.')).toBeUndefined();
	});

	it('names none of an empty or blank paste', () => {
		expect(pastedImagePath('')).toBeUndefined();
		expect(pastedImagePath('   ')).toBeUndefined();
	});
});
