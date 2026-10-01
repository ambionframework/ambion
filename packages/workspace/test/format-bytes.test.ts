import { expect, it } from 'vitest';
import { formatBytes } from '../src/format-bytes.ts';

it.each([
	[0, '0 bytes'],
	[1023, '1023 bytes'],
	[1024, '1 KiB'],
	[1536, '1.5 KiB'],
	[6000, '5.9 KiB'],
	[5 * 1024 * 1024, '5 MiB'],
	[40.5 * 1024 * 1024, '40.5 MiB'],
	[32 * 1024 * 1024, '32 MiB'],
	[5 * 1024 ** 3, '5 GiB'],
	[5 * 1024 ** 3 + 1, '5.0 GiB'],
])('shows %d bytes as %s', (bytes, text) => {
	expect(formatBytes(bytes)).toBe(text);
});
