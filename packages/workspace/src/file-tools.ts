/**
 * The four file tools of every workspace: `read`, `write`, `edit`, and
 * `apply_patch`. Each one runs over the port of a bash backend, through the
 * whole-operation queue of the resource, so a call sees the files as the
 * previous call left them.
 *
 * The names, parameters, and results of `read`, `write`, and `edit` derive
 * from the file tools of the agent harness of Pi (earendil-works/pi, MIT
 * License, Mario Zechner). The envelope of `apply_patch` follows the
 * `apply_patch` tool of Codex.
 */

import {
	type AmbionTool,
	defineTool,
	type ToolContext,
	type ToolResult,
} from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import {
	APPLY_PATCH_DESCRIPTION,
	applyPatchFiles,
	applyPatchSchema,
	prepareApplyPatchArguments,
} from './apply-patch-tool.ts';
import type { WorkspaceEnv } from './backend.ts';
import {
	applyEdits,
	detectLineEnding,
	diffText,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
	unifiedPatch,
} from './edit-diff.ts';
import { accessError, assertLive, readEditable, resolvePath, text, value } from './file-support.ts';
import { imageMimeType } from './image-type.ts';
import { TruncationFacts } from './process-schema.ts';
import { lineRange, SCAN_BYTES, type Scan, scanLines } from './read-scan.ts';
import type { WorkspaceResource } from './resource.ts';
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type Truncation,
	truncateHead,
} from './truncate.ts';

const readSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
	offset: Type.Optional(
		Type.Integer({ description: 'Line number to start reading from (1-indexed)' }),
	),
	limit: Type.Optional(Type.Integer({ description: 'Maximum number of lines to read' })),
});

/** The declared output of `read`: the text with no notice, and where it sits in the file. */
const ReadOutput = Type.Object(
	{
		path: Type.String({ description: 'The absolute path of the file.' }),
		text: Type.String({
			description:
				'The file text from line `from`, with no notice. Empty for an image, and when the first line alone exceeds the byte limit.',
		}),
		from: Type.Optional(
			Type.Integer({ description: 'The first line of text, counted from 1. Absent for an image.' }),
		),
		to: Type.Optional(
			Type.Integer({
				description: 'The last line of text. It is one less than from when text is empty.',
			}),
		),
		lines: Type.Optional(
			Type.Integer({
				description:
					'The lines in the file. Present when the scan reached the end of the file, and absent when the view ended it early.',
			}),
		),
		next: Type.Optional(
			Type.Integer({ description: 'The offset to read next when more lines of the file remain.' }),
		),
		truncation: Type.Optional(TruncationFacts),
		image: Type.Optional(
			Type.Object(
				{ mimeType: Type.String({ description: 'The image type, such as image/png.' }) },
				{ description: 'Set for an image file. The image itself does not reach code.' },
			),
		),
	},
	{ $id: 'ReadResult' },
);

/** What `read` gives in `details`. */
type ReadDetails = Static<typeof ReadOutput>;

const writeSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
	content: Type.String({ description: 'Content to write to the file' }),
});

const editSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description: 'Exact text for one targeted replacement.',
			}),
			newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
		}),
		{
			description:
				'One or more targeted replacements. Each edit is matched against the original file, not incrementally.',
		},
	),
});

type ReadParams = Static<typeof readSchema>;
type WriteParams = Static<typeof writeSchema>;
type EditParams = Static<typeof editSchema>;

/**
 * The path of a file to read. A screenshot name can differ from the name that
 * a model types in the narrow space before AM or PM, in the form of its
 * accents, and in its apostrophe. The first form that exists wins.
 */
async function resolveReadPath(
	env: WorkspaceEnv,
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	const resolved = await resolvePath(env, path, signal);
	const forms = [
		resolved,
		resolved.replace(/ (AM|PM)\./gi, '\u202F$1.'),
		resolved.normalize('NFD'),
		resolved.replace(/'/g, '\u2019'),
		resolved.normalize('NFD').replace(/'/g, '\u2019'),
	];
	for (const form of new Set(forms)) {
		if (value(await env.exists(form, signal))) return form;
	}
	return resolved;
}

/** The result of a `read` of an image: the format, the attachment, and the path. */
async function readImage(
	env: WorkspaceEnv,
	path: string,
	bytes: Uint8Array,
	mimeType: string,
	signal?: AbortSignal,
): Promise<ToolResult<ReadDetails>> {
	const resolved = await env.absolutePath(path, signal);
	const shown = resolved.ok ? resolved.value : path;
	const details: ReadDetails = { path: shown, text: '', image: { mimeType } };
	const note = { type: 'text' as const, text: `Image path: ${shown}` };
	if (mimeType === 'image/bmp') {
		return {
			content: [
				{
					type: 'text',
					text: `Read image file [image/bmp]\n[Image omitted: BMP has no image part. Convert the file to PNG with bash to see it.]`,
				},
				note,
			],
			details,
		};
	}
	return {
		content: [
			{ type: 'text', text: `Read image file [${mimeType}]` },
			{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType },
			note,
		],
		details,
	};
}

/** The notice after the lines of a `read` that a limit cut short, and the reason. */
function readNotice(
	truncation: Pick<ReturnType<typeof truncateHead>, 'truncatedBy' | 'outputLines'>,
	first: number,
	total: number | undefined,
): string {
	const last = first + truncation.outputLines - 1;
	const where = `Showing lines ${first}-${last}${total === undefined ? '' : ` of ${total}`}`;
	const limit =
		truncation.truncatedBy === 'lines' ? '' : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
	return `\n\n[${where}${limit}. Use offset=${last + 1} to continue.]`;
}

/** The notice after the lines of a `read` that end before the file does. */
function moreNotice(end: number, total: number | undefined): string {
	const count = total === undefined ? 'More lines' : `${total - end} more lines`;
	return `\n\n[${count} in file. Use offset=${end + 1} to continue.]`;
}

/** What a cut kept and dropped. */
type Cut = Omit<Truncation, 'content'>;

/** The view of a `read`: the text that fits the limits, and what the cut dropped. */
function cutView(scan: Scan): { content: string; facts: Cut } {
	const { content, ...cut } = truncateHead(
		new TextDecoder('utf-8', { ignoreBOM: true }).decode(scan.bytes),
	);
	if (!cut.truncated) return { content, facts: cut };
	return { content, facts: { ...cut, totalLines: scan.seen.lines, totalBytes: scan.seen.bytes } };
}

/** The result of a `read` that starts at a first line over the byte limit. */
function longLine(scan: Scan, given: string, view: ReadDetails, facts: Cut) {
	const size = formatSize(scan.firstLineBytes);
	const sed = `sed -n '${view.from}p' ${given} | head -c ${DEFAULT_MAX_BYTES}`;
	return text(
		`[Line ${view.from} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: ${sed}]`,
		{ ...view, text: '', truncation: facts },
	);
}

/** The result of a `read` of a view that a limit of the file tools did not cut. */
function readWindow(scan: Scan, view: ReadDetails, hasLimit: boolean): ToolResult<ReadDetails> {
	const total = scan.file?.elements;
	const end = Math.min(scan.range.end, total ?? Number.POSITIVE_INFINITY);
	const more = total === undefined ? scan.more : end < total;
	if (!hasLimit || !more) return text(view.text, view);
	return text(view.text + moreNotice(end, total), { ...view, next: end + 1 });
}

/** The result of a `read` of a text file at `path`, an absolute path. */
function readText(
	scan: Scan,
	{ path: given, offset, limit }: ReadParams,
	path: string,
): ToolResult<ReadDetails> {
	const { start } = scan.range;
	const total = scan.file?.elements;
	if (total !== undefined && start >= total) {
		throw new Error(`Offset ${offset} is beyond end of file (${total} lines total)`);
	}
	const { content, facts } = cutView(scan);
	const first = start + 1;
	const last = first + facts.outputLines - 1;
	const view: ReadDetails = {
		path,
		text: content,
		from: first,
		to: last,
		...(scan.file === undefined ? {} : { lines: scan.file.lines }),
	};
	if (facts.firstLineExceedsLimit) return longLine(scan, given, view, facts);
	if (!facts.truncated) return readWindow(scan, view, limit !== undefined);
	return text(content + readNotice(facts, first, total), {
		...view,
		next: last + 1,
		truncation: facts,
	});
}

async function readFile(
	env: WorkspaceEnv,
	params: ReadParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult<ReadDetails>> {
	const path = await resolveReadPath(env, params.path, signal);
	const first = value(await env.readRange(path, 0, SCAN_BYTES, signal));
	const mimeType = imageMimeType(first);
	if (mimeType !== undefined) {
		const bytes = value(await env.readBinaryFile(path, signal));
		return readImage(env, params.path, bytes, mimeType, signal);
	}
	const range = lineRange(params.offset, params.limit);
	return readText(await scanLines(env, path, range, first, signal), params, path);
}

async function writeFile(
	env: WorkspaceEnv,
	{ path, content }: WriteParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const absolute = await resolvePath(env, path, signal);
	assertLive(signal);
	value(await env.writeFile(absolute, content, signal));
	assertLive(signal);
	return text(`Successfully wrote to ${path}`);
}

async function editFile(
	env: WorkspaceEnv,
	{ path, edits }: EditParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	if (edits.length === 0) {
		throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
	}
	const absolute = await resolvePath(env, path, signal);
	assertLive(signal);
	const original = await readEditable(env, path, absolute, signal);
	assertLive(signal);
	const { bom, text: content } = stripBom(original);
	const ending = detectLineEnding(content);
	const { baseContent, newContent } = applyEdits(normalizeToLF(content), edits, path);
	assertLive(signal);
	const written = await env.writeFile(
		absolute,
		bom + restoreLineEndings(newContent, ending),
		signal,
	);
	if (!written.ok) throw accessError(path, written.error);
	assertLive(signal);
	const { diff, firstChangedLine } = diffText(baseContent, newContent);
	return text(`Successfully replaced ${edits.length} block(s) in ${path}.`, {
		diff,
		patch: unifiedPatch(path, baseContent, newContent),
		firstChangedLine,
	});
}

/** Whether `value` is one replacement. */
function isEdit(candidate: unknown): candidate is { oldText: string; newText: string } {
	if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false;
	const edit = candidate as Record<string, unknown>;
	return typeof edit.oldText === 'string' && typeof edit.newText === 'string';
}

function parseJson(source: string): unknown {
	try {
		return JSON.parse(source);
	} catch {
		return undefined;
	}
}

/** The `edits` of a call as a list: a JSON string, one replacement, or a list. Other values stay. */
function editList(edits: unknown): unknown {
	const parsed = typeof edits === 'string' ? parseJson(edits) : edits;
	if (Array.isArray(parsed)) return parsed;
	return isEdit(parsed) ? [parsed] : edits;
}

/**
 * Accept the argument forms that a model gives: `edits` as a JSON string or
 * as one replacement, and `oldText` and `newText` beside `path`, which join
 * the list as the last replacement.
 */
function prepareEditArguments(input: unknown): EditParams {
	if (typeof input !== 'object' || input === null) return input as EditParams;
	const given = input as Record<string, unknown>;
	const edits = editList(given.edits);
	const args: Record<string, unknown> = edits === given.edits ? { ...given } : { ...given, edits };
	const { oldText, newText, ...rest } = args;
	if (typeof oldText !== 'string' || typeof newText !== 'string') return args as EditParams;
	const listed = Array.isArray(args.edits) ? args.edits : [];
	return { ...rest, edits: [...listed, { oldText, newText }] } as EditParams;
}

/** The four file tools, run through the queue of `use`. */
export function fileTools(use: WorkspaceResource<WorkspaceEnv>['use']): readonly AmbionTool[] {
	const through =
		<P, R extends ToolResult>(
			operation: (env: WorkspaceEnv, params: P, signal: AbortSignal | undefined) => Promise<R>,
		) =>
		(params: P, ctx: ToolContext): Promise<R> =>
			use(ctx.agent, (env) => operation(env, params, ctx.signal), ctx.signal);
	return Object.freeze([
		defineTool({
			name: 'read',
			label: 'read',
			description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments, with the path of the file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
			parameters: readSchema,
			compose: { output: ReadOutput },
			execute: through(readFile),
		}),
		defineTool({
			name: 'write',
			label: 'write',
			description:
				"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
			parameters: writeSchema,
			execute: through(writeFile),
		}),
		defineTool({
			name: 'edit',
			label: 'edit',
			description:
				'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
			parameters: editSchema,
			prepareArguments: prepareEditArguments,
			execute: through(editFile),
		}),
		defineTool({
			name: 'apply_patch',
			label: 'apply_patch',
			description: APPLY_PATCH_DESCRIPTION,
			parameters: applyPatchSchema,
			prepareArguments: prepareApplyPatchArguments,
			execute: through(applyPatchFiles),
		}),
	]);
}
