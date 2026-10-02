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
import type { WorkspaceResource } from './resource.ts';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from './truncate.ts';

const readSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to read (relative or absolute)' }),
	offset: Type.Optional(
		Type.Number({ description: 'Line number to start reading from (1-indexed)' }),
	),
	limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
});

const writeSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
	content: Type.String({ description: 'Content to write to the file' }),
});

const editSchema = Type.Object({
	path: Type.String({ description: 'Path to the file to edit (relative or absolute)' }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({
				description:
					'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.',
			}),
			newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
		}),
		{
			description:
				'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
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
): Promise<ToolResult> {
	const resolved = await env.absolutePath(path, signal);
	const note = {
		type: 'text' as const,
		text: `Image path: ${resolved.ok ? resolved.value : path}`,
	};
	if (mimeType === 'image/bmp') {
		return {
			content: [
				{
					type: 'text',
					text: `Read image file [image/bmp]\n[Image omitted: BMP has no image part. Convert the file to PNG with bash to see it.]`,
				},
				note,
			],
			details: undefined,
		};
	}
	return {
		content: [
			{ type: 'text', text: `Read image file [${mimeType}]` },
			{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType },
			note,
		],
		details: undefined,
	};
}

/** The notice after the lines of a `read` that a limit cut short, and the reason. */
function readNotice(
	truncation: ReturnType<typeof truncateHead>,
	first: number,
	total: number,
): string {
	const last = first + truncation.outputLines - 1;
	const where = `Showing lines ${first}-${last} of ${total}`;
	const limit =
		truncation.truncatedBy === 'lines' ? '' : ` (${formatSize(DEFAULT_MAX_BYTES)} limit)`;
	return `\n\n[${where}${limit}. Use offset=${last + 1} to continue.]`;
}

/** The result of a `read` of a text file. */
function readText(bytes: Uint8Array, { path, offset, limit }: ReadParams): ToolResult {
	const lines = new TextDecoder().decode(bytes).split('\n');
	const start = offset ? Math.max(0, offset - 1) : 0;
	if (start >= lines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
	}
	const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
	const truncation = truncateHead(lines.slice(start, end).join('\n'));
	const first = start + 1;
	if (truncation.firstLineExceedsLimit) {
		const size = formatSize(Buffer.byteLength(lines[start] ?? '', 'utf8'));
		const sed = `sed -n '${first}p' ${path} | head -c ${DEFAULT_MAX_BYTES}`;
		return text(
			`[Line ${first} is ${size}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: ${sed}]`,
			{ truncation },
		);
	}
	if (truncation.truncated) {
		return text(truncation.content + readNotice(truncation, first, lines.length), { truncation });
	}
	if (limit !== undefined && end < lines.length) {
		const more = `\n\n[${lines.length - end} more lines in file. Use offset=${end + 1} to continue.]`;
		return text(truncation.content + more);
	}
	return text(truncation.content);
}

async function readFile(
	env: WorkspaceEnv,
	params: ReadParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const path = await resolveReadPath(env, params.path, signal);
	const bytes = value(await env.readBinaryFile(path, signal));
	const mimeType = imageMimeType(bytes);
	return mimeType === undefined
		? readText(bytes, params)
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
		<P>(
			operation: (
				env: WorkspaceEnv,
				params: P,
				signal: AbortSignal | undefined,
			) => Promise<ToolResult>,
		) =>
		(params: P, ctx: ToolContext): Promise<ToolResult> =>
			use(ctx.agent, (env) => operation(env, params, ctx.signal), ctx.signal);
	return Object.freeze([
		defineTool({
			name: 'read',
			label: 'read',
			description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments, with the path of the file. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
			parameters: readSchema,
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
