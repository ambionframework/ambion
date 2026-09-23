/**
 * `Capture` holds a command's output within a bound, and its view reports
 * the whole output's size after a trim.
 */

import { boundedView } from '@ambionframework/workspace';
import { expect, it } from 'vitest';
import { Capture } from '../src/capture.ts';

const encode = (text: string) => Buffer.from(text, 'utf8');

it('gives the same view as boundedView while nothing is trimmed', () => {
	const limits = { maxBytes: 1_000, maxLines: 2 };
	const capture = new Capture(limits);
	for (const chunk of ['a\n', 'b\nc', '\nd\n']) capture.push(encode(chunk));
	capture.finish();
	expect(capture.view()).toEqual(boundedView('a\nb\nc\nd\n', limits));
});

it('keeps the tail, and counts every byte and line, after the window trims', () => {
	const capture = new Capture({ maxBytes: 100, maxLines: 100_000 });
	const line = `${'x'.repeat(9)}\n`;
	for (let i = 0; i < 10_000; i += 1) capture.push(encode(`${i}:${line}`));
	capture.finish();
	const view = capture.view();
	expect(Buffer.byteLength(view.text)).toBeLessThanOrEqual(100);
	expect(view.text.endsWith(`9999:${line.trimEnd()}`)).toBe(true);
	expect(view.truncation).toMatchObject({
		truncated: true,
		truncatedBy: 'bytes',
		totalLines: 10_000,
	});
	expect(view.truncation.totalBytes).toBeGreaterThan(100_000);
});

it('keeps the head when the caller retains the head', () => {
	const capture = new Capture({ maxBytes: 10, maxLines: 1_000, retain: 'head' });
	for (let i = 0; i < 1_000; i += 1) capture.push(encode(`${i}\n`));
	capture.finish();
	expect(capture.view().text.startsWith('0\n1\n2\n')).toBe(true);
	expect(capture.view().truncation).toMatchObject({ truncated: true, totalLines: 1_000 });
});

it('decodes a character that two chunks split', () => {
	const capture = new Capture(undefined);
	const bytes = encode('é\n');
	capture.push(bytes.subarray(0, 1));
	capture.push(bytes.subarray(1));
	capture.finish();
	expect(capture.view().text).toBe('é\n');
});
