/**
 * The text work of the `edit` tool: line endings and the byte order mark,
 * the match of each `oldText` in a file, and the diff of the change.
 *
 * Every `oldText` is matched against the original content, never against
 * the result of another edit. A match is exact. When no match is exact, the
 * text matches after a normal form that drops trailing whitespace and maps
 * typographic quotes, dashes, and spaces to ASCII.
 *
 * The code derives from the edit tool of the agent harness of Pi
 * (earendil-works/pi, MIT License, Mario Zechner).
 */

import { createTwoFilesPatch, diffLines, FILE_HEADERS_ONLY } from 'diff';

/** One replacement of the `edit` tool. */
export interface Edit {
	readonly oldText: string;
	readonly newText: string;
}

/** The lines of unchanged text that the diff shows on each side of a change. */
const CONTEXT_LINES = 4;

/** A matched replacement: where in the matched content, how long, and what replaces it. */
interface Replacement {
	readonly editIndex: number;
	readonly matchIndex: number;
	readonly matchLength: number;
	readonly newText: string;
}

/** A found `oldText`, in the content that the replacement works on. */
interface TextMatch {
	readonly index: number;
	readonly length: number;
	readonly fuzzy: boolean;
}

/** The text that the lines of the content start and end at. */
interface Span {
	readonly start: number;
	readonly end: number;
}

/** The first line ending of the content: `\r\n` when it comes before the first `\n` alone. */
export function detectLineEnding(content: string): '\r\n' | '\n' {
	const crlf = content.indexOf('\r\n');
	const lf = content.indexOf('\n');
	return crlf !== -1 && crlf < lf ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
	return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/** The byte order mark of the content, if any, and the content without it. */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith('﻿')
		? { bom: '﻿', text: content.slice(1) }
		: { bom: '', text: content };
}

/** The normal form of fuzzy matching. */
function fuzzyNormalForm(text: string): string {
	return text
		.normalize('NFKC')
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, '-')
		.replace(/[  -   　]/g, ' ');
}

/** The exact match of `oldText`, else its match in the normal form of `content`. */
function findText(content: string, oldText: string): TextMatch | undefined {
	const exact = content.indexOf(oldText);
	if (exact !== -1) return { index: exact, length: oldText.length, fuzzy: false };
	const fuzzyOldText = fuzzyNormalForm(oldText);
	const fuzzy = fuzzyNormalForm(content).indexOf(fuzzyOldText);
	return fuzzy === -1 ? undefined : { index: fuzzy, length: fuzzyOldText.length, fuzzy: true };
}

function occurrences(content: string, oldText: string): number {
	return fuzzyNormalForm(content).split(fuzzyNormalForm(oldText)).length - 1;
}

/** The lines of the content, each with its newline. */
function splitLines(content: string): string[] {
	return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function lineSpans(content: string): Span[] {
	let offset = 0;
	return splitLines(content).map((line) => {
		const span = { start: offset, end: offset + line.length };
		offset = span.end;
		return span;
	});
}

const OUTSIDE = 'Replacement range is outside the base content.';

/** The lines that a replacement touches: the first, and one past the last. */
function touchedLines(spans: readonly Span[], replacement: Replacement): Span {
	const matchEnd = replacement.matchIndex + replacement.matchLength;
	const first = spans.findIndex(
		(line) => replacement.matchIndex >= line.start && replacement.matchIndex < line.end,
	);
	if (first === -1) throw new Error(OUTSIDE);
	let last = first;
	while (last < spans.length && (spans[last]?.end ?? 0) < matchEnd) last++;
	if (last >= spans.length) throw new Error(OUTSIDE);
	return { start: first, end: last + 1 };
}

/** The content with each replacement applied, last first so that the earlier offsets hold. */
function applyReplacements(
	content: string,
	replacements: readonly Replacement[],
	offset = 0,
): string {
	let result = content;
	for (const replacement of replacements.toReversed()) {
		const at = replacement.matchIndex - offset;
		result = result.slice(0, at) + replacement.newText + result.slice(at + replacement.matchLength);
	}
	return result;
}

/** Replacements that touch the same lines, or lines that follow each other, in one block. */
interface Group extends Span {
	readonly replacements: Replacement[];
}

function groupByLines(spans: readonly Span[], replacements: readonly Replacement[]): Group[] {
	const groups: Group[] = [];
	for (const replacement of replacements.toSorted((a, b) => a.matchIndex - b.matchIndex)) {
		const range = touchedLines(spans, replacement);
		const current = groups.at(-1);
		if (current !== undefined && range.start < current.end) {
			groups[groups.length - 1] = {
				start: current.start,
				end: Math.max(current.end, range.end),
				replacements: [...current.replacements, replacement],
			};
		} else {
			groups.push({ ...range, replacements: [replacement] });
		}
	}
	return groups;
}

/**
 * Apply replacements that matched in `baseContent`, a normal form of
 * `originalContent`, and keep the lines that no replacement touches as the
 * original has them. The lines that a replacement touches come from the
 * normal form.
 */
function applyPreservingLines(
	originalContent: string,
	baseContent: string,
	replacements: readonly Replacement[],
): string {
	const originalLines = splitLines(originalContent);
	const spans = lineSpans(baseContent);
	if (originalLines.length !== spans.length) {
		throw new Error(
			'Cannot preserve unchanged lines because the base content has a different line count.',
		);
	}
	let next = 0;
	let result = '';
	for (const group of groupByLines(spans, replacements)) {
		result += originalLines.slice(next, group.start).join('');
		const from = spans[group.start]?.start ?? 0;
		const to = spans[group.end - 1]?.end ?? 0;
		result += applyReplacements(baseContent.slice(from, to), group.replacements, from);
		next = group.end;
	}
	return result + originalLines.slice(next).join('');
}

function notFound(path: string, index: number, total: number): Error {
	return new Error(
		total === 1
			? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
			: `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function duplicate(path: string, index: number, total: number, found: number): Error {
	return new Error(
		total === 1
			? `Found ${found} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
			: `Found ${found} occurrences of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function emptyOldText(path: string, index: number, total: number): Error {
	return new Error(
		total === 1
			? `oldText must not be empty in ${path}.`
			: `edits[${index}].oldText must not be empty in ${path}.`,
	);
}

function noChange(path: string, total: number): Error {
	return new Error(
		total === 1
			? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
			: `No changes made to ${path}. The replacements produced identical content.`,
	);
}

/** Each edit matched once in `base`, or the error that names the edit that did not. */
function matchEdits(base: string, edits: readonly Edit[], path: string): Replacement[] {
	return edits.map((edit, editIndex) => {
		const match = findText(base, edit.oldText);
		if (match === undefined) throw notFound(path, editIndex, edits.length);
		const found = occurrences(base, edit.oldText);
		if (found > 1) throw duplicate(path, editIndex, edits.length, found);
		return {
			editIndex,
			matchIndex: match.index,
			matchLength: match.length,
			newText: edit.newText,
		};
	});
}

/** Refuse two matches that share text. `sorted` runs by `matchIndex`. */
function assertDisjoint(sorted: readonly Replacement[], path: string): void {
	for (const [i, current] of sorted.entries()) {
		const previous = sorted[i - 1];
		if (previous !== undefined && previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}
}

/**
 * Apply the edits to content with `\n` line endings. All edits match the
 * same original content. When one edit needs a fuzzy match, all work in the
 * normal form, and the lines that no edit touches keep their original text.
 */
export function applyEdits(
	content: string,
	edits: readonly Edit[],
	path: string,
): { baseContent: string; newContent: string } {
	const normalized = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	const empty = normalized.findIndex((edit) => edit.oldText.length === 0);
	if (empty !== -1) throw emptyOldText(path, empty, normalized.length);
	const fuzzy = normalized.some((edit) => findText(content, edit.oldText)?.fuzzy);
	const base = fuzzy ? fuzzyNormalForm(content) : content;
	const matched = matchEdits(base, normalized, path).toSorted(
		(a, b) => a.matchIndex - b.matchIndex,
	);
	assertDisjoint(matched, path);
	const newContent = fuzzy
		? applyPreservingLines(content, base, matched)
		: applyReplacements(base, matched);
	if (newContent === content) throw noChange(path, normalized.length);
	return { baseContent: content, newContent };
}

/** A unified patch of the change. */
export function unifiedPatch(path: string, oldContent: string, newContent: string): string {
	return createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: CONTEXT_LINES,
		headerOptions: FILE_HEADERS_ONLY,
	});
}

/** The line numbers of the diff walk, and the lines it has written. */
interface Walk {
	readonly output: string[];
	readonly width: number;
	oldLine: number;
	newLine: number;
}

function numbered(sign: string, line: number, width: number, text: string): string {
	return `${sign}${String(line).padStart(width, ' ')} ${text}`;
}

/** Write the added or removed lines of one part. */
function writeChange(walk: Walk, lines: readonly string[], added: boolean): void {
	for (const text of lines) {
		walk.output.push(
			added
				? numbered('+', walk.newLine++, walk.width, text)
				: numbered('-', walk.oldLine++, walk.width, text),
		);
	}
}

function writeContext(walk: Walk, lines: readonly string[]): void {
	for (const text of lines) {
		walk.output.push(numbered(' ', walk.oldLine++, walk.width, text));
		walk.newLine++;
	}
}

/**
 * Write the unchanged lines of one part: the first `head` lines, a gap
 * marker for the `skipped` lines, and the last `tail` lines.
 */
function writeUnchanged(walk: Walk, lines: readonly string[], head: number, tail: number): void {
	const skipped = lines.length - head - tail;
	writeContext(walk, lines.slice(0, head));
	if (skipped > 0 && (head > 0 || tail > 0)) {
		walk.output.push(` ${''.padStart(walk.width, ' ')} ...`);
	}
	walk.oldLine += skipped;
	walk.newLine += skipped;
	writeContext(walk, lines.slice(lines.length - tail));
}

/** How many lines of an unchanged part show at its start and at its end. */
function shownLines(
	length: number,
	afterChange: boolean,
	beforeChange: boolean,
): { head: number; tail: number } {
	if (afterChange && beforeChange) {
		return length <= CONTEXT_LINES * 2
			? { head: length, tail: 0 }
			: { head: CONTEXT_LINES, tail: CONTEXT_LINES };
	}
	if (afterChange) return { head: Math.min(length, CONTEXT_LINES), tail: 0 };
	return { head: 0, tail: beforeChange ? Math.min(length, CONTEXT_LINES) : 0 };
}

/**
 * A diff for the model to read: each changed line with its number and a sign,
 * and the lines around a change. `firstChangedLine` is the line number of the
 * first change in the new content.
 */
export function diffText(
	oldContent: string,
	newContent: string,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = diffLines(oldContent, newContent);
	const width = String(
		Math.max(oldContent.split('\n').length, newContent.split('\n').length),
	).length;
	const walk: Walk = { output: [], width, oldLine: 1, newLine: 1 };
	let firstChangedLine: number | undefined;
	let afterChange = false;
	for (const [i, part] of parts.entries()) {
		const lines = part.value.split('\n');
		if (lines.at(-1) === '') lines.pop();
		const changed = part.added || part.removed;
		if (changed) {
			firstChangedLine ??= walk.newLine;
			writeChange(walk, lines, part.added);
		} else {
			const next = parts[i + 1];
			const shown = shownLines(lines.length, afterChange, next?.added || next?.removed || false);
			writeUnchanged(walk, lines, shown.head, shown.tail);
		}
		afterChange = changed;
	}
	return { diff: walk.output.join('\n'), firstChangedLine };
}
