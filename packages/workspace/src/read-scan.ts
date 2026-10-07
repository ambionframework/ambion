/**
 * The scan of the `read` tool over a text file. The scan reads the file in
 * ranges of `SCAN_BYTES`, counts the newline bytes, and keeps the bytes of
 * the lines of the view. It holds one range and the view at a time, so the
 * memory use does not depend on the size of the file. A file of any size
 * gives a view, as long as the view starts where the scan can reach.
 *
 * A line is the text between two newline bytes. The text after the last
 * newline is a line, also when it is empty. Line numbers here count from 0.
 */

import type { WorkspaceEnv } from './backend.ts';
import { assertLive, value } from './file-support.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from './truncate.ts';

/** The bytes of one range read. The scan holds at most one range. */
export const SCAN_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;
const BOM = [0xef, 0xbb, 0xbf];
const SEPARATOR = new Uint8Array([NEWLINE]);

/** The most bytes that the scan keeps: the limit of a view, and two more bytes so a cut stays visible. */
const KEEP_BYTES = DEFAULT_MAX_BYTES + 2;

/** The most lines that the scan keeps: the limit of a view, and two more lines so a cut stays visible. */
const KEEP_LINES = DEFAULT_MAX_LINES + 2;

/** The lines of a view. `start` is the first line, and `end` is the line after the last. */
export interface LineRange {
	readonly start: number;
	readonly end: number;
}

/** What a scan found. */
export interface Scan {
	readonly range: LineRange;
	/** The bytes of the lines of the view, cut at `KEEP_BYTES` and at `KEEP_LINES`. */
	readonly bytes: Uint8Array;
	/** The bytes of the first line of the view, also when `bytes` holds part of it. */
	readonly firstLineBytes: number;
	/** The lines and the bytes of the range, as far as the scan saw them. A final empty line does not count. */
	readonly seen: { readonly lines: number; readonly bytes: number };
	/** True when the file has a line at `range.end`. */
	readonly more: boolean;
	/** Set when the scan reached the end of the file. */
	readonly file?: {
		/** The lines of the file, with the empty line after a final newline. */
		readonly elements: number;
		/** The lines of the file, with no empty line after a final newline. */
		readonly lines: number;
	};
}

/** The range that an offset and a limit name. The offset counts from 1. */
export function lineRange(offset: number | undefined, limit: number | undefined): LineRange {
	const start = offset ? Math.max(0, offset - 1) : 0;
	return {
		start,
		end: limit === undefined ? Number.POSITIVE_INFINITY : Math.max(start, start + limit),
	};
}

/** The state of one scan over the ranges of a file, in order. */
class LineScan {
	/** The newline bytes before the current position, and so the number of the current line. */
	private newlines = 0;
	/** The bytes of the current line so far. */
	private open = 0;
	/** Whether the last line of the range ended with no byte. Set when that line closes. */
	private endsEmpty = false;
	private firstLine = 0;
	private rangeBytes = 0;
	private kept = 0;
	private readonly pieces: Uint8Array[] = [];
	/** The line after the last line that the scan keeps. */
	private readonly keepEnd: number;

	constructor(private readonly range: LineRange) {
		this.keepEnd = Math.min(range.end, range.start + KEEP_LINES);
	}

	/**
	 * Whether the view is decided: the scan has the line after the kept lines,
	 * or it has kept the byte limit and has seen the end of the first line.
	 */
	get decided(): boolean {
		return (
			this.newlines >= this.keepEnd || (this.kept >= KEEP_BYTES && this.newlines > this.range.start)
		);
	}

	/** Scan one range of the file to its end. */
	feed(chunk: Uint8Array, from = 0): void {
		let position = from;
		for (;;) {
			const at = chunk.indexOf(NEWLINE, position);
			if (at === -1) {
				this.take(chunk, position, chunk.length);
				return;
			}
			this.take(chunk, position, at);
			this.close();
			position = at + 1;
		}
	}

	/** The bytes of the current line from `from` to `to`. */
	private take(chunk: Uint8Array, from: number, to: number): void {
		const length = to - from;
		this.open += length;
		const line = this.newlines;
		if (line < this.range.start || line >= this.range.end) return;
		this.rangeBytes += length;
		if (line === this.range.start) this.firstLine += length;
		if (line < this.keepEnd) this.keep(chunk.subarray(from, to));
	}

	/** A newline byte ends the current line. */
	private close(): void {
		const line = this.newlines;
		const { start, end } = this.range;
		if (line >= start && line + 1 < end) this.rangeBytes += 1;
		if (line >= start && line + 1 < this.keepEnd) this.keep(SEPARATOR);
		if (line >= start && line + 1 === end) this.endsEmpty = this.open === 0;
		this.newlines += 1;
		this.open = 0;
	}

	private keep(bytes: Uint8Array): void {
		const room = KEEP_BYTES - this.kept;
		if (room <= 0 || bytes.length === 0) return;
		const piece = bytes.slice(0, room);
		this.pieces.push(piece);
		this.kept += piece.length;
	}

	/** The result of the scan. `reachedEnd` is true when the last range ended the file. */
	result(reachedEnd: boolean): Scan {
		const lines = this.newlines + 1;
		const inRange = Math.max(0, Math.min(this.range.end, lines) - this.range.start);
		const last = this.newlines >= this.range.end ? this.endsEmpty : this.open === 0;
		return {
			range: this.range,
			bytes: Buffer.concat(this.pieces, this.kept),
			firstLineBytes: this.firstLine,
			seen: {
				lines: inRange === 0 ? 0 : inRange - (last ? 1 : 0),
				bytes: this.rangeBytes,
			},
			more: this.newlines >= this.range.end,
			...(reachedEnd
				? { file: { elements: lines, lines: this.open === 0 ? lines - 1 : lines } }
				: {}),
		};
	}
}

function startsWithBom(bytes: Uint8Array): boolean {
	return BOM.every((byte, index) => bytes[index] === byte);
}

/**
 * Scan the file at `path` for the lines of `range`. `first` is the range
 * that the caller read at byte 0, with `SCAN_BYTES` as its length. The scan
 * reads the next range only when the view is not decided and the last range
 * was full. The scan checks `signal` between two reads.
 */
export async function scanLines(
	env: Pick<WorkspaceEnv, 'readRange'>,
	path: string,
	range: LineRange,
	first: Uint8Array,
	signal?: AbortSignal,
): Promise<Scan> {
	const scan = new LineScan(range);
	let chunk = first;
	let position = 0;
	scan.feed(chunk, startsWithBom(chunk) ? BOM.length : 0);
	while (chunk.length === SCAN_BYTES && !scan.decided) {
		position += chunk.length;
		assertLive(signal);
		chunk = value(await env.readRange(path, position, SCAN_BYTES, signal));
		scan.feed(chunk);
	}
	return scan.result(chunk.length < SCAN_BYTES);
}
