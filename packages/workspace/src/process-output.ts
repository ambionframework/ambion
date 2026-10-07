/**
 * The output of a process as a handle tool gives it: the part after the
 * cursor, bounded to the default view of 2000 lines or 50 KB.
 *
 * The `cursor` file of a process holds the byte offset up to which the
 * results of its owner agent already showed the output. Each read gives the
 * output after that offset, and moves the cursor to the end it read. The
 * whole output stays in `out`, and `read` reaches any part of it. The files
 * hold the cursor, so a new run of the host reads on from the same offset.
 *
 * A new part that fits the default view shows whole. A longer one shows its
 * first and its last half: the first 1000 lines or 25 KB, and the last 1000
 * lines or 25 KB. The read takes the first 50 KB and the last 50 KB of the
 * new part, so a burst of any size costs two bounded reads. Two `wc -l`
 * counts give the line numbers of the output file, and the view names the
 * lines between the halves in the terms of `read`. The cursor counts bytes,
 * so a read can end inside a UTF-8 character that the process has not
 * finished writing. That character then shows as two replacement marks,
 * one at the end of each read, and no byte shows twice.
 */

import type { WorkspaceEnv } from './backend.ts';
import { runScript, shellQuote } from './execution-env.ts';
import type { ShellOutputTruncation } from './port.ts';
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type Truncation,
	truncateHead,
	truncateTail,
} from './truncate.ts';

/** The limits of each half of a cut view. */
const HALF = { maxLines: DEFAULT_MAX_LINES / 2, maxBytes: DEFAULT_MAX_BYTES / 2 };

/**
 * The most bytes a script returns. A read takes at most 50 KB of the file,
 * and invalid UTF-8 can grow to three times that size in the text.
 */
const SCRIPT_BYTES = 4 * DEFAULT_MAX_BYTES;

/** A range of lines in the output file, in the terms of `read`. */
export interface LineRange {
	/** The first line of the range, counted from 1. */
	readonly offset: number;
	/** The lines in the range. */
	readonly limit: number;
}

/** The two ends that a cut view shows, and what lies between them. */
interface OutputCut {
	/** The end of the new output. */
	readonly tail: string;
	/** The lines of the start that the view shows, and the lines of `tail`. */
	readonly headLines: number;
	readonly tailLines: number;
	/** The lines of the output file between the two ends. Absent when no whole line lies between them. */
	readonly omitted?: LineRange;
}

/** What one read of the output gives. */
export interface OutputRead {
	/** The new output when the view shows it whole. When the view is cut, the start of it. */
	readonly text: string;
	/** Set when the view is cut: the end, and the lines between. */
	readonly cut?: OutputCut;
	readonly truncation: ShellOutputTruncation;
	/** The byte offset where the read started: the cursor before the read. */
	readonly from: number;
	/** The byte offset where the read ended: the size of the file when the read began. */
	readonly to: number;
}

/** The raw text of the two ends of the new output. They are one text when it is short. */
interface Ends {
	readonly headRaw: string;
	readonly tailRaw: string;
}

/** The first and the last line of the output file that the new output touches. */
interface Span {
	readonly first: number;
	readonly last: number;
}

/** The newline counts of the output file before `from` and up to `size`. */
interface Newlines {
	readonly before: number;
	readonly upTo: number;
}

/**
 * Read the output of the process in `dir` after its cursor, and move the
 * cursor to the end it read. A cursor past the end of the file, or one
 * that does not parse, reads from the start.
 */
export async function readOutput(env: WorkspaceEnv, dir: string): Promise<OutputRead> {
	const path = `${dir}/out`;
	const info = await env.fileInfo(path);
	const size = info.ok ? info.value.size : 0;
	const cursor = await readCursor(env, dir);
	const from = cursor > size ? 0 : cursor;
	const ends = await endsOf(env, path, from, size);
	if (size !== cursor) await writeCursor(env, dir, size);
	const range = { from, to: size };
	const { content, ...whole } = truncateTail(ends.tailRaw);
	if (size - from <= DEFAULT_MAX_BYTES && !whole.truncated) {
		return { text: content, truncation: whole, ...range };
	}
	const newlines = await newlinesOf(env, path, from, size);
	return { ...cutView(ends, newlines, size - from), ...range };
}

/** The new output from byte `from` to byte `size`, or its first and last 50 KB when it is longer. */
async function endsOf(env: WorkspaceEnv, path: string, from: number, size: number): Promise<Ends> {
	const count = size - from;
	if (count <= 0) return { headRaw: '', tailRaw: '' };
	if (count <= DEFAULT_MAX_BYTES) {
		const raw = await bytesOf(env, path, size, count);
		return { headRaw: raw, tailRaw: raw };
	}
	const first = await bytesOf(env, path, from + DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES);
	return {
		headRaw: first.slice(0, first.lastIndexOf('\n') + 1),
		tailRaw: await bytesOf(env, path, size, DEFAULT_MAX_BYTES),
	};
}

/**
 * The cut view of the new output: `count` bytes in the two ends, with the
 * newline counts of the file when they are known.
 */
function cutView(
	{ headRaw, tailRaw }: Ends,
	newlines: Newlines | undefined,
	count: number,
): Pick<OutputRead, 'text' | 'cut' | 'truncation'> {
	const head = truncateHead(headRaw, HALF);
	const tail = truncateTail(tailRaw, HALF);
	const lines = newlines && lineSpan(newlines, tailRaw);
	const total = lines ? lines.last - lines.first + 1 : head.outputLines + tail.outputLines;
	return {
		text: head.content,
		cut: {
			tail: tail.content,
			headLines: head.outputLines,
			tailLines: tail.outputLines,
			...(lines ? omittedBetween(head, tail, lines) : {}),
		},
		truncation: {
			truncated: true,
			truncatedBy: total > DEFAULT_MAX_LINES ? 'lines' : 'bytes',
			totalLines: total,
			totalBytes: count,
			outputLines: head.outputLines + tail.outputLines,
			outputBytes: head.outputBytes + tail.outputBytes,
			lastLinePartial: tail.lastLinePartial,
			firstLineExceedsLimit: head.firstLineExceedsLimit || headRaw === '',
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		},
	};
}

function lineSpan(newlines: Newlines, tailRaw: string): Span {
	return {
		first: newlines.before + 1,
		last: newlines.upTo + (tailRaw.endsWith('\n') ? 0 : 1),
	};
}

/** The `omitted` field of a cut: the lines between the two ends, when there is at least one. */
function omittedBetween(head: Truncation, tail: Truncation, span: Span): { omitted?: LineRange } {
	const offset = span.first + head.outputLines;
	const limit = span.last - tail.outputLines + 1 - offset;
	return limit > 0 ? { omitted: { offset, limit } } : {};
}

/** The byte offset in `cursor`, or 0 when the file is absent or does not parse. */
async function readCursor(env: WorkspaceEnv, dir: string): Promise<number> {
	const read = await env.readTextFile(`${dir}/cursor`);
	if (!read.ok) return 0;
	const offset = Number.parseInt(read.value, 10);
	return Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
}

/** Write the cursor. Best-effort: a failed write makes the next read give the same bytes again. */
async function writeCursor(env: WorkspaceEnv, dir: string, offset: number): Promise<void> {
	await env.writeFile(`${dir}/cursor`, `${offset}\n`).catch(() => undefined);
}

/**
 * The last `count` bytes of the first `size` bytes of the file. `head`
 * fixes the end at the size the read saw, so output that the process
 * writes during the read waits for the next read. just-bash's `tail`
 * refuses `--` and reads `-c +N` as `-c N`, so the command uses neither.
 * The path is absolute, so it cannot read as an option. The error text of
 * `head` goes nowhere, so a file that goes away reads as empty.
 */
async function bytesOf(
	env: WorkspaceEnv,
	path: string,
	size: number,
	count: number,
): Promise<string> {
	const ran = await runScript(
		env,
		`head -c ${size} ${shellQuote(path)} 2>/dev/null | tail -c ${count}`,
		{
			capture: {
				limits: { maxBytes: SCRIPT_BYTES, maxLines: Number.MAX_SAFE_INTEGER, retain: 'tail' },
			},
		},
	);
	return ran.ok ? ran.value.output : '';
}

/**
 * The count of newlines in the first `from` bytes and in the first `size`
 * bytes of the file, or undefined when the script gives none. The path is
 * absolute and quoted, and the error text goes nowhere, as in `bytesOf`.
 */
async function newlinesOf(
	env: WorkspaceEnv,
	path: string,
	from: number,
	size: number,
): Promise<Newlines | undefined> {
	const file = shellQuote(path);
	const ran = await runScript(
		env,
		`head -c ${from} ${file} 2>/dev/null | wc -l; head -c ${size} ${file} 2>/dev/null | wc -l`,
		{ capture: { limits: { maxBytes: 256, maxLines: 8 } } },
	);
	if (!ran.ok) return undefined;
	const [before, upTo] = ran.value.output.split('\n').map((line) => Number.parseInt(line, 10));
	return before === undefined || upTo === undefined || Number.isNaN(before) || Number.isNaN(upTo)
		? undefined
		: { before, upTo };
}
