/**
 * The three file tools of every workspace: `read`, `write`, and `edit`. Each
 * one runs over the port of a bash backend, through the whole-operation
 * queue of the resource, so a call sees the files as the previous call left
 * them.
 *
 * The names, parameters, and results derive from the file tools of the agent
 * harness of Pi (earendil-works/pi, MIT License, Mario Zechner).
 */

import {
	type AmbionTool,
	defineTool,
	type ToolContext,
	type ToolResult,
} from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
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
import { imageMimeType } from './image-type.ts';
import type { FileError, Result } from './port.ts';
import { TruncationFacts } from './process-schema.ts';
import type { WorkspaceResource } from './resource.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate.ts';

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
		lines: Type.Optional(Type.Integer({ description: 'The lines in the file.' })),
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

/** The value of a result, or its error thrown. */
function value<T>(result: Result<T, FileError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function assertLive(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error('Operation aborted');
}

function text(message: string): ToolResult<undefined>;
function text<D>(message: string, details: D): ToolResult<D>;
function text(message: string, details?: unknown): ToolResult {
	return { content: [{ type: 'text', text: message }], details };
}

/** An error for a file that the tool could not reach, with the cause. */
function accessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

/** The absolute path of a tool path. A leading `@` and the Unicode spaces of a pasted path go. */
async function resolvePath(env: WorkspaceEnv, path: string, signal?: AbortSignal): Promise<string> {
	const plain = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
	return value(await env.absolutePath(plain.startsWith('@') ? plain.slice(1) : plain, signal));
}

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
	total: number,
): string {
	const last = first + truncation.outputLines - 1;
	const where = `Showing lines ${first}-${last} of ${total}`;
	const limit =
		truncation.truncatedBy === 'lines' ? '' : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
	return `\n\n[${where}${limit}. Use offset=${last + 1} to continue.]`;
}

/** The lines of a file: none for an empty file, and no empty line after a final newline. */
function lineCount(lines: readonly string[]): number {
	if (lines.length === 1 && lines[0] === '') return 0;
	return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

/** The result of a `read` of a text file at `path`, an absolute path. */
function readText(
	bytes: Uint8Array,
	{ path: given, offset, limit }: ReadParams,
	path: string,
): ToolResult<ReadDetails> {
	const lines = new TextDecoder().decode(bytes).split('\n');
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
	}
	const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
	const { content, ...facts } = truncateHead(lines.slice(start, end).join('\n'));
	const first = start + 1;
	const last = first + facts.outputLines - 1;
	const view: ReadDetails = {
		path,
		text: content,
		from: first,
		to: last,
		lines: lineCount(lines),
	};
	if (facts.firstLineExceedsLimit) {
		const size = formatSize(Buffer.byteLength(lines[start] ?? '', 'utf8'));
		const sed = `sed -n '${first}p' ${given} | head -c ${DEFAULT_MAX_BYTES}`;
		return text(
			`[Line ${first} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: ${sed}]`,
			{ ...view, text: '', truncation: facts },
		);
	}
	if (facts.truncated) {
		const notice = readNotice(facts, first, lines.length);
		return text(content + notice, { ...view, next: last + 1, truncation: facts });
	}
	if (limit !== undefined && end < lines.length) {
		const more = `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
		return text(content + more, { ...view, next: end + 1 });
	}
	return text(content, view);
}

async function readFile(
	env: WorkspaceEnv,
	params: ReadParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult<ReadDetails>> {
	const path = await resolveReadPath(env, params.path, signal);
	const bytes = value(await env.readBinaryFile(path, signal));
	const mimeType = imageMimeType(bytes);
	return mimeType === undefined
		? readText(bytes, params, path)
		: readImage(env, params.path, bytes, mimeType, signal);
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

/** The content of a file that `edit` may change, or the error that names why it may not. */
async function readEditable(
	env: WorkspaceEnv,
	path: string,
	absolute: string,
	signal?: AbortSignal,
): Promise<string> {
	const info = await env.fileInfo(absolute, signal);
	if (!info.ok) throw accessError(path, info.error);
	if (info.value.kind !== 'file' && info.value.kind !== 'symlink') {
		throw new Error(`Could not edit file: ${path}. Path is not a file.`);
	}
	const content = await env.readTextFile(absolute, signal);
	if (!content.ok) throw accessError(path, content.error);
	return content.value;
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

/** The three file tools, run through the queue of `use`. */
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
	]);
}
