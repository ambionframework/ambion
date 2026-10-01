/** The cuts of `truncateHead` and `truncateTail`, and `formatSize`. */
import { describe, expect, it } from 'vitest';
import { formatSize, truncateHead, truncateTail } from '../src/truncate.ts';

describe('truncate', () => {
	it.each([
		{
			name: 'a head cut by lines',
			cut: truncateHead('a\nb\nc', { maxLines: 2 }),
			content: 'a\nb',
			truncatedBy: 'lines',
			outputLines: 2,
		},
		{
			name: 'a head cut by bytes',
			cut: truncateHead('aa\nbb\ncc', { maxBytes: 6 }),
			content: 'aa\nbb',
			truncatedBy: 'bytes',
			outputLines: 2,
		},
		{
			name: 'a tail cut by lines',
			cut: truncateTail('a\nb\nc', { maxLines: 2 }),
			content: 'b\nc',
			truncatedBy: 'lines',
			outputLines: 2,
		},
		{
			name: 'a tail cut by bytes',
			cut: truncateTail('aa\nbb\ncc', { maxBytes: 6 }),
			content: 'bb\ncc',
			truncatedBy: 'bytes',
			outputLines: 2,
		},
		{
			name: 'a tail cut inside a last line that exceeds the byte limit',
			cut: truncateTail('ab\nxyzxyz', { maxBytes: 4 }),
			content: 'zxyz',
			truncatedBy: 'bytes',
			outputLines: 1,
			lastLinePartial: true,
		},
		{
			name: 'a tail cut that keeps a whole four-byte character',
			cut: truncateTail('ab\nx😀😀', { maxBytes: 5 }),
			content: '😀',
			truncatedBy: 'bytes',
			outputLines: 1,
			lastLinePartial: true,
		},
	])('gives $name', ({ cut, content, truncatedBy, outputLines, lastLinePartial = false }) => {
		expect(cut).toMatchObject({
			content,
			truncated: true,
			truncatedBy,
			outputLines,
			lastLinePartial,
		});
	});

	it('cuts nothing from text inside both limits, and counts a final newline as no line', () => {
		expect(truncateHead('a\nb\n')).toMatchObject({
			content: 'a\nb\n',
			truncated: false,
			truncatedBy: null,
			totalLines: 2,
			totalBytes: 4,
		});
	});

	it.each([
		[0, '0B'],
		[1023, '1023B'],
		[1536, '1.5KB'],
		[5 * 1024 * 1024, '5.0MB'],
	])('formats %i bytes as %s', (bytes, size) => {
		expect(formatSize(bytes)).toBe(size);
	});
});
