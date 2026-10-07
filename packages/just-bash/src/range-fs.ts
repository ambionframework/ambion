/**
 * The optional byte-range read of a just-bash filesystem. A filesystem that
 * has it reads a range of a file of any size. One that has not gives a whole
 * file through `readFileBuffer`, and the caller cuts the range.
 */

import type { IFileSystem } from 'just-bash';

/** A filesystem that reads at most `length` bytes of a file from the byte `start`. */
export interface RangeFs {
	readRange(path: string, start: number, length: number): Promise<Uint8Array>;
}

/** The range read of `fs`, or undefined when `fs` has none. */
export function rangeReader(fs: IFileSystem): RangeFs['readRange'] | undefined {
	const candidate = fs as Partial<RangeFs>;
	return typeof candidate.readRange === 'function' ? candidate.readRange.bind(fs) : undefined;
}
