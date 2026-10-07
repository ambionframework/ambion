/**
 * The text work of the `apply_patch` tool: apply the body of one file of a
 * patch to the content of that file. The body is a headerless V4A diff.
 *
 * - Mode `default` patches an existing file. A section starts with one or
 *   more `@@` anchors and holds lines that start with a space (context),
 *   `-` (delete), or `+` (insert). The first section needs no anchor. A
 *   section that ends with `*** End of File` matches at the end of the file.
 * - Mode `create` builds a new file. Every line starts with `+`.
 *
 * A section matches the lines of the file in three passes from the cursor:
 * exact, then with the whitespace at the end of each line dropped, then with
 * the whitespace at both ends dropped. An anchor matches in two passes,
 * exact then trimmed. The function keeps the line ending of the file, and the
 * trailing newline state. It throws when the diff does not apply cleanly.
 *
 * The code derives from `applyDiff` of the OpenAI Agents SDK
 * (openai/openai-agents-js, MIT License, OpenAI).
 *
 * MIT License
 *
 * Copyright (c) 2025 OpenAI
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** One change to the lines of the file: the lines to delete, and the lines to insert there. */
interface Chunk {
	readonly origIndex: number;
	readonly delLines: readonly string[];
	readonly insLines: readonly string[];
}

/** The lines of a diff, and the index of the next line to read. */
interface Parser {
	readonly lines: readonly string[];
	index: number;
}

type LineMode = 'keep' | 'add' | 'delete';

/** The lines that one section of the diff covers, and the changes in them. */
interface Section {
	readonly context: string[];
	readonly chunks: Chunk[];
	delLines: string[];
	insLines: string[];
	mode: LineMode;
}

/** A section read from the diff, and where the next one starts. */
interface SectionRead {
	readonly context: readonly string[];
	readonly chunks: readonly Chunk[];
	readonly endIndex: number;
	readonly eof: boolean;
}

const END_PATCH = '*** End Patch';
const END_FILE = '*** End of File';
const FILE_HEADERS = ['*** Update File:', '*** Delete File:', '*** Add File:'];
const SECTION_TERMINATORS = [END_PATCH, ...FILE_HEADERS];
const END_SECTION_MARKERS = [...SECTION_TERMINATORS, END_FILE];

/** The line ending of the file. The first bare `\n` makes it `\n`. */
function fileLineEnding(input: string): '\n' | '\r\n' {
	const first = input.indexOf('\n');
	if (first === -1) return '\n';
	for (let index = first; index !== -1; index = input.indexOf('\n', index + 1)) {
		if (index === 0 || input[index - 1] !== '\r') return '\n';
	}
	return '\r\n';
}

/** The lines of a diff with no carriage return, and no empty line after the final newline. */
function normalizeDiffLines(diff: string): string[] {
	return diff
		.split(/\r?\n/)
		.map((line) => line.replace(/\r$/, ''))
		.filter((line, index, all) => !(index === all.length - 1 && line === ''));
}

function isDone(parser: Parser, prefixes: readonly string[]): boolean {
	const line = parser.lines[parser.index];
	return line === undefined || prefixes.some((prefix) => line.startsWith(prefix));
}

/** The text after `prefix` in the current line, which the parser then passes. Empty when no match. */
function readStr(parser: Parser, prefix: string): string {
	const current = parser.lines[parser.index];
	if (current === undefined || !current.startsWith(prefix)) return '';
	parser.index += 1;
	return current.slice(prefix.length);
}

/** The content of a new file: each line of the diff starts with `+`. */
function parseCreateDiff(lines: readonly string[]): string {
	const parser: Parser = { lines: [...lines, END_PATCH], index: 0 };
	const output: string[] = [];
	while (!isDone(parser, SECTION_TERMINATORS)) {
		const line = parser.lines[parser.index] ?? '';
		parser.index += 1;
		if (!line.startsWith('+')) {
			throw new Error(`Invalid Add File Line: ${line}`);
		}
		output.push(line.slice(1));
	}
	return output.join('\n');
}

/** The anchors at the current line: the text of each, and how many markers there were. */
function readAnchors(parser: Parser): { anchors: string[]; anchorCount: number } {
	const anchors: string[] = [];
	let anchorCount = 0;
	for (;;) {
		const before = parser.index;
		const anchor = readStr(parser, '@@ ');
		if (parser.index === before && parser.lines[parser.index] === '@@') parser.index += 1;
		if (parser.index === before) return { anchors, anchorCount };
		anchorCount += 1;
		if (anchor.trim()) anchors.push(anchor);
	}
}

/**
 * Look for a line that `matches`, from the cursor on. A match before the
 * cursor counts as found and leaves the cursor, when `searchBefore` is set.
 */
function locate(
	lines: readonly string[],
	cursor: number,
	matches: (line: string) => boolean,
	searchBefore: boolean,
): { found: boolean; cursor: number } {
	if (searchBefore && lines.slice(0, cursor).some(matches)) return { found: true, cursor };
	const offset = lines.slice(cursor).findIndex(matches);
	return offset === -1 ? { found: false, cursor } : { found: true, cursor: cursor + offset + 1 };
}

/**
 * The cursor after an anchor: just after the first line that equals the
 * anchor, or else the first line that equals it when trimmed. The search
 * runs forward, and it counts a match before the cursor unless
 * `forceForwardSearch` is set. A missing anchor leaves the cursor, and it
 * throws when `requireMatch` is set.
 */
function advanceCursorToAnchor(
	anchor: string,
	inputLines: readonly string[],
	cursor: number,
	requireMatch: boolean,
	forceForwardSearch: boolean,
): number {
	const searchBefore = !forceForwardSearch;
	const exact = locate(inputLines, cursor, (line) => line === anchor, searchBefore);
	const wanted = anchor.trim();
	const result = exact.found
		? exact
		: locate(inputLines, cursor, (line) => line.trim() === wanted, searchBefore);
	if (requireMatch && !result.found) {
		throw new Error(`Invalid Anchor ${cursor}:\n${anchor}`);
	}
	return result.cursor;
}

/** Whether a line of a diff ends the section that is being read. */
function endsSection(raw: string): boolean {
	return (
		raw === '***' || raw.startsWith('@@') || END_SECTION_MARKERS.some((m) => raw.startsWith(m))
	);
}

function modeOf(line: string): LineMode {
	if (line.startsWith('+')) return 'add';
	if (line.startsWith('-')) return 'delete';
	if (line.startsWith(' ')) return 'keep';
	throw new Error(`Invalid Line: ${line}`);
}

/** Close the change that the section collects, when it holds one. */
function flushChunk(section: Section): void {
	if (!section.insLines.length && !section.delLines.length) return;
	section.chunks.push({
		origIndex: section.context.length - section.delLines.length,
		delLines: section.delLines,
		insLines: section.insLines,
	});
	section.delLines = [];
	section.insLines = [];
}

/** Add one line of the diff to the section. A line with no text counts as an empty context line. */
function consumeLine(section: Section, raw: string): void {
	const line = raw === '' ? ' ' : raw;
	const mode = modeOf(line);
	const text = line.slice(1);
	if (mode === 'keep' && section.mode !== 'keep') flushChunk(section);
	section.mode = mode;
	if (mode === 'add') {
		section.insLines.push(text);
		return;
	}
	if (mode === 'delete') section.delLines.push(text);
	section.context.push(text);
}

/** Read one section: the lines that it covers in the file, and the changes in them. */
function readSection(lines: readonly string[], startIndex: number): SectionRead {
	const section: Section = { context: [], chunks: [], delLines: [], insLines: [], mode: 'keep' };
	let index = startIndex;
	while (index < lines.length) {
		const raw = lines[index] ?? '';
		if (endsSection(raw)) break;
		if (raw.startsWith('***')) throw new Error(`Invalid Line: ${raw}`);
		index += 1;
		consumeLine(section, raw);
	}
	flushChunk(section);
	const { context, chunks } = section;
	if (lines[index] === END_FILE) return { context, chunks, endIndex: index + 1, eof: true };
	if (index === startIndex) {
		throw new Error(`Nothing in this section - index=${index} ${lines[index]}`);
	}
	return { context, chunks, endIndex: index, eof: false };
}

/** Whether `context` equals the lines of `source` from `start`, after `mapFn` of each line. */
function equalsSlice(
	source: readonly string[],
	target: readonly string[],
	start: number,
	mapFn: (value: string) => string,
): boolean {
	if (start + target.length > source.length) return false;
	return target.every((line, offset) => mapFn(source[start + offset] ?? '') === mapFn(line));
}

/** The matching passes, from the strictest to the loosest. */
const MATCH_PASSES: readonly ((line: string) => string)[] = [
	(line) => line,
	(line) => line.trimEnd(),
	(line) => line.trim(),
];

/** The first index from `start` where `context` matches in one pass of `MATCH_PASSES`. */
function findContextCore(
	lines: readonly string[],
	context: readonly string[],
	start: number,
): number {
	if (!context.length) return start;
	for (const mapFn of MATCH_PASSES) {
		for (let index = start; index < lines.length; index += 1) {
			if (equalsSlice(lines, context, index, mapFn)) return index;
		}
	}
	return -1;
}

/**
 * Where `context` starts in `lines`, or -1. A context at the end of the file
 * matches the last lines first, and falls back to a search from `start`.
 */
function findContext(
	lines: readonly string[],
	context: readonly string[],
	start: number,
	eof: boolean,
): number {
	if (!eof) return findContextCore(lines, context, start);
	const searchLines = lines.length > 1 && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
	const endStart = Math.max(0, searchLines.length - context.length);
	const endMatch = findContextCore(searchLines, context, endStart);
	if (endMatch !== -1) return endMatch;
	return findContextCore(searchLines, context, Math.min(start, searchLines.length));
}

/** The cursor after the anchors of one section. */
function moveToAnchors(
	anchors: readonly string[],
	anchorCount: number,
	inputLines: readonly string[],
	start: number,
): number {
	let cursor = start;
	for (const [index, anchor] of anchors.entries()) {
		cursor = advanceCursorToAnchor(anchor, inputLines, cursor, anchorCount > 1, index > 0);
	}
	return cursor;
}

/** Read one section with its anchors, and add its changes to `chunks`. The next cursor returns. */
function parseHunk(
	parser: Parser,
	inputLines: readonly string[],
	chunks: Chunk[],
	cursor: number,
): number {
	const { anchors, anchorCount } = readAnchors(parser);
	if (anchorCount === 0 && cursor !== 0) {
		throw new Error(`Invalid Line:\n${parser.lines[parser.index]}`);
	}
	const from = moveToAnchors(anchors, anchorCount, inputLines, cursor);
	const section = readSection(parser.lines, parser.index);
	const newIndex = findContext(inputLines, section.context, from, section.eof);
	if (newIndex === -1) {
		const kind = section.eof ? 'Invalid EOF Context' : 'Invalid Context';
		throw new Error(`${kind} ${from}:\n${section.context.join('\n')}`);
	}
	for (const chunk of section.chunks) {
		chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
	}
	parser.index = section.endIndex;
	return newIndex + section.context.length;
}

function parseUpdateDiff(lines: readonly string[], input: string): Chunk[] {
	const parser: Parser = { lines: [...lines, END_PATCH], index: 0 };
	const inputLines = input.split('\n');
	const chunks: Chunk[] = [];
	let cursor = 0;
	while (!isDone(parser, END_SECTION_MARKERS)) {
		cursor = parseHunk(parser, inputLines, chunks, cursor);
	}
	return chunks;
}

/** Join the lines of the file with the changes of `chunks` made, in the line ending `lineEnding`. */
function applyChunks(input: string, chunks: readonly Chunk[], lineEnding: '\n' | '\r\n'): string {
	const origLines = input.split('\n');
	const destLines: string[] = [];
	let origIndex = 0;
	for (const chunk of chunks) {
		if (chunk.origIndex > origLines.length) {
			throw new Error(
				`applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${origLines.length}`,
			);
		}
		if (origIndex > chunk.origIndex) {
			throw new Error(`applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex})`);
		}
		for (const line of origLines.slice(origIndex, chunk.origIndex)) destLines.push(line);
		for (const line of chunk.insLines) destLines.push(line);
		origIndex = chunk.origIndex + chunk.delLines.length;
	}
	for (const line of origLines.slice(origIndex)) destLines.push(line);
	return destLines.join(lineEnding);
}

/**
 * Apply a headerless V4A diff to the content of a file. Mode `create` reads a
 * diff in which every line starts with `+`, and the content in `input` has
 * no effect.
 */
export function applyDiff(
	input: string,
	diff: string,
	mode: 'default' | 'create' = 'default',
): string {
	const diffLines = normalizeDiffLines(diff);
	if (mode === 'create') return parseCreateDiff(diffLines);
	const lineEnding = fileLineEnding(input);
	const normalizedInput = lineEnding === '\r\n' ? input.replace(/\r\n/g, '\n') : input;
	return applyChunks(normalizedInput, parseUpdateDiff(diffLines, normalizedInput), lineEnding);
}
