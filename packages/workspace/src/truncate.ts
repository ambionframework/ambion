/**
 * Bounds for text that a tool shows to a model: the first lines of a file
 * and the last lines of a command output. Two limits apply, and the first
 * one reached wins: a count of lines and a count of bytes. A cut never
 * leaves a partial line, except for the last line of a tail cut that alone
 * exceeds the byte limit.
 *
 * The code derives from the truncation helpers of the agent harness of Pi
 * (earendil-works/pi, MIT License, Mario Zechner).
 */

/** The most lines a view shows. */
export const DEFAULT_MAX_LINES = 2000;

/** The most bytes a view shows. */
export const DEFAULT_MAX_BYTES = 50 * 1024;

/** The limits of one cut. A limit that is absent takes its default. */
export interface TruncationOptions {
	readonly maxLines?: number;
	readonly maxBytes?: number;
}

/** What a cut kept, and what the original held. */
export interface Truncation {
	readonly content: string;
	readonly truncated: boolean;
	/** The limit that the cut reached first, or null when it cut nothing. */
	readonly truncatedBy: 'lines' | 'bytes' | null;
	readonly totalLines: number;
	readonly totalBytes: number;
	readonly outputLines: number;
	readonly outputBytes: number;
	/** The first line of the output is the end of a longer line. A tail cut only. */
	readonly lastLinePartial: boolean;
	/** The first line alone exceeds the byte limit. A head cut only. */
	readonly firstLineExceedsLimit: boolean;
	readonly maxLines: number;
	readonly maxBytes: number;
}

/** The kept part of a cut, and the facts that differ from one cut to the next. */
interface Kept {
	readonly lines: readonly string[];
	readonly truncatedBy: 'lines' | 'bytes';
	readonly lastLinePartial?: boolean;
	readonly firstLineExceedsLimit?: boolean;
}

/** The content under measure, with the limits that apply to it. */
interface Counted {
	readonly content: string;
	readonly lines: readonly string[];
	readonly totalBytes: number;
	readonly maxLines: number;
	readonly maxBytes: number;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');

/** `1B`, `1.5KB`, or `1.5MB`. */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** The lines of `content`. A final newline ends the last line. It starts no empty line. */
function linesOf(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split('\n');
	if (content.endsWith('\n')) lines.pop();
	return lines;
}

function count(content: string, options: TruncationOptions): Counted {
	return {
		content,
		lines: linesOf(content),
		totalBytes: bytesOf(content),
		maxLines: options.maxLines ?? DEFAULT_MAX_LINES,
		maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
	};
}

const fits = (counted: Counted): boolean =>
	counted.lines.length <= counted.maxLines && counted.totalBytes <= counted.maxBytes;

/** The result of a cut that dropped nothing. */
function whole(counted: Counted): Truncation {
	return {
		content: counted.content,
		truncated: false,
		truncatedBy: null,
		totalLines: counted.lines.length,
		totalBytes: counted.totalBytes,
		outputLines: counted.lines.length,
		outputBytes: counted.totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: counted.maxLines,
		maxBytes: counted.maxBytes,
	};
}

/** The result of a cut that dropped some of the content. */
function cut(counted: Counted, kept: Kept): Truncation {
	const content = kept.lines.join('\n');
	return {
		content,
		truncated: true,
		truncatedBy: kept.truncatedBy,
		totalLines: counted.lines.length,
		totalBytes: counted.totalBytes,
		outputLines: kept.lines.length,
		outputBytes: bytesOf(content),
		lastLinePartial: kept.lastLinePartial ?? false,
		firstLineExceedsLimit: kept.firstLineExceedsLimit ?? false,
		maxLines: counted.maxLines,
		maxBytes: counted.maxBytes,
	};
}

/**
 * Keep the first lines of `content`. A first line that alone exceeds the
 * byte limit gives empty content and `firstLineExceedsLimit`.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): Truncation {
	const counted = count(content, options);
	if (fits(counted)) return whole(counted);
	if (bytesOf(counted.lines[0] ?? '') > counted.maxBytes) {
		return cut(counted, {
			lines: [],
			truncatedBy: 'bytes',
			firstLineExceedsLimit: true,
		});
	}
	return cut(counted, leadingLines(counted));
}

/** The first lines that fit both limits. */
function leadingLines(counted: Counted): Kept {
	const lines: string[] = [];
	let bytes = 0;
	for (const line of counted.lines.slice(0, counted.maxLines)) {
		const lineBytes = bytesOf(line) + (lines.length > 0 ? 1 : 0);
		if (bytes + lineBytes > counted.maxBytes) return { lines, truncatedBy: 'bytes' };
		lines.push(line);
		bytes += lineBytes;
	}
	return { lines, truncatedBy: 'lines' };
}

/**
 * Keep the last lines of `content`. The last line alone can exceed the byte
 * limit. Then the output is the end of that line, and `lastLinePartial` is
 * true.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): Truncation {
	const counted = count(content, options);
	if (fits(counted)) return whole(counted);
	return cut(counted, trailingLines(counted));
}

/** The last lines that fit both limits. */
function trailingLines(counted: Counted): Kept {
	const lines: string[] = [];
	let bytes = 0;
	for (const line of counted.lines.toReversed()) {
		if (lines.length >= counted.maxLines) break;
		const lineBytes = bytesOf(line) + (lines.length > 0 ? 1 : 0);
		if (bytes + lineBytes > counted.maxBytes) {
			return lines.length === 0 ? partialLine(line, counted) : { lines, truncatedBy: 'bytes' };
		}
		lines.unshift(line);
		bytes += lineBytes;
	}
	return { lines, truncatedBy: 'lines' };
}

/** The end of a last line that alone exceeds the byte limit. */
function partialLine(line: string, counted: Counted): Kept {
	return {
		lines: [endOfLine(line, counted.maxBytes)],
		truncatedBy: counted.maxLines <= 1 ? 'lines' : 'bytes',
		lastLinePartial: true,
	};
}

/** The UTF-8 size of the UTF-16 character that ends at `end`, and where it starts. */
function characterBefore(text: string, end: number): { start: number; bytes: number } {
	const code = text.charCodeAt(end - 1);
	if (code >= 0xdc00 && code <= 0xdfff && end > 1) {
		const previous = text.charCodeAt(end - 2);
		if (previous >= 0xd800 && previous <= 0xdbff) return { start: end - 2, bytes: 4 };
		return { start: end - 1, bytes: 3 };
	}
	if (code >= 0xd800 && code <= 0xdfff) return { start: end - 1, bytes: 3 };
	return { start: end - 1, bytes: code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3 };
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** The end of `text` that fits `maxBytes`, cut at a character. A lone surrogate becomes U+FFFD. */
function endOfLine(text: string, maxBytes: number): string {
	let used = 0;
	let start = text.length;
	while (start > 0) {
		const character = characterBefore(text, start);
		if (used + character.bytes > maxBytes) break;
		used += character.bytes;
		start = character.start;
	}
	return text.slice(start).replace(LONE_SURROGATE, '\ufffd');
}
