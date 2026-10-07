/**
 * The `apply_patch` tool: one patch that adds, deletes, updates, and moves
 * files. A call parses the envelope (`./patch-envelope.ts`), then runs every
 * operation in memory (`./apply-diff.ts` reads each body), and writes only
 * when every operation succeeded.
 *
 * The envelope follows the `apply_patch` tool of Codex.
 */

import type { ToolResult } from '@ambionframework/ambion';
import { type Static, Type } from 'typebox';
import { applyDiff } from './apply-diff.ts';
import type { WorkspaceEnv } from './backend.ts';
import { normalizeToLF, stripBom, unifiedPatch } from './edit-diff.ts';
import { assertLive, readEditable, resolvePath, text } from './file-support.ts';
import { type PatchOperation, parsePatch } from './patch-envelope.ts';

export const APPLY_PATCH_DESCRIPTION = [
	'Apply a patch to one or more files. All changes apply, or none do. A patch has this form:',
	'*** Begin Patch',
	'*** Add File: <path>  (each line after it starts with +)',
	'*** Delete File: <path>',
	'*** Update File: <path>',
	'*** Move to: <new path>  (optional, right after Update File)',
	'@@ <line of the file that precedes the change>  (optional; stack several @@ lines to narrow it)',
	' <unchanged line>',
	'-<line to remove>',
	'+<line to add>',
	'*** End of File  (optional; the change is at the end of the file)',
	'*** End Patch',
	'Give about three unchanged lines of context before and after each change. Paths are relative or absolute.',
].join('\n');

export const applyPatchSchema = Type.Object({
	input: Type.String({ description: 'The patch, from "*** Begin Patch" to "*** End Patch".' }),
});

type ApplyPatchParams = Static<typeof applyPatchSchema>;

/** What `apply_patch` gives in `details`: each operation of the patch, and the unified diff of all of them. */
interface ApplyPatchDetails {
	readonly files: readonly {
		readonly path: string;
		readonly action: 'add' | 'update' | 'delete' | 'move';
		readonly to?: string;
	}[];
	readonly patch: string;
}

/** One operation after it ran in memory: what it did, and its unified diff. */
interface PatchStep {
	readonly file: ApplyPatchDetails['files'][number];
	readonly patch: string;
}

/** A file that the patch writes, or deletes when `content` is null, with its path as the patch names it. */
interface StagedFile {
	readonly path: string;
	readonly content: string | null;
}

/** The files that the operations so far write or delete, by absolute path. */
interface PatchRun {
	readonly env: WorkspaceEnv;
	readonly staged: Map<string, StagedFile>;
	readonly signal: AbortSignal | undefined;
}

const OPERATION_NAMES = { add: 'Add File', delete: 'Delete File', update: 'Update File' } as const;

/** The text of a file as a diff shows it: no byte order mark, and `\n` line endings. */
const diffable = (content: string): string => normalizeToLF(stripBom(content).text);

/** The content of a file as the patch has left it so far. Undefined when the file does not exist. */
async function currentContent(
	run: PatchRun,
	path: string,
	absolute: string,
): Promise<string | undefined> {
	const earlier = run.staged.get(absolute);
	if (earlier !== undefined) return earlier.content ?? undefined;
	const info = await run.env.fileInfo(absolute, run.signal);
	if (!info.ok && info.error.code === 'not_found') return undefined;
	return readEditable(run.env, path, absolute, run.signal);
}

async function existingContent(run: PatchRun, path: string, absolute: string): Promise<string> {
	const content = await currentContent(run, path, absolute);
	if (content === undefined) throw new Error('The file does not exist.');
	return content;
}

/** The content of a new file: the lines of the body, each with a final newline. */
function newFileContent(body: string): string {
	const content = applyDiff('', body, 'create');
	return content === '' || content.endsWith('\n') ? content : `${content}\n`;
}

async function stageAdd(
	run: PatchRun,
	{ path, body }: Extract<PatchOperation, { kind: 'add' }>,
	absolute: string,
): Promise<PatchStep> {
	const before = (await currentContent(run, path, absolute)) ?? '';
	const content = newFileContent(body);
	run.staged.set(absolute, { path, content });
	return { file: { path, action: 'add' }, patch: unifiedPatch(path, diffable(before), content) };
}

async function stageDelete(
	run: PatchRun,
	{ path }: Extract<PatchOperation, { kind: 'delete' }>,
	absolute: string,
): Promise<PatchStep> {
	const before = await existingContent(run, path, absolute);
	run.staged.set(absolute, { path, content: null });
	return { file: { path, action: 'delete' }, patch: unifiedPatch(path, diffable(before), '') };
}

async function stageUpdate(
	run: PatchRun,
	{ path, moveTo, body }: Extract<PatchOperation, { kind: 'update' }>,
	absolute: string,
): Promise<PatchStep> {
	const before = await existingContent(run, path, absolute);
	if (body.trim() === '' && moveTo === undefined) throw new Error('The update holds no change.');
	const { bom, text: plain } = stripBom(before);
	const updated = body.trim() === '' ? plain : applyDiff(plain, body);
	const patch = unifiedPatch(path, normalizeToLF(plain), normalizeToLF(updated), moveTo);
	if (moveTo === undefined) {
		run.staged.set(absolute, { path, content: bom + updated });
		return { file: { path, action: 'update' }, patch };
	}
	const target = await resolvePath(run.env, moveTo, run.signal);
	await currentContent(run, moveTo, target);
	run.staged.set(absolute, { path, content: null });
	run.staged.set(target, { path: moveTo, content: bom + updated });
	return { file: { path, action: 'move', to: moveTo }, patch };
}

async function stageBy(run: PatchRun, operation: PatchOperation): Promise<PatchStep> {
	const absolute = await resolvePath(run.env, operation.path, run.signal);
	switch (operation.kind) {
		case 'add':
			return stageAdd(run, operation, absolute);
		case 'delete':
			return stageDelete(run, operation, absolute);
		case 'update':
			return stageUpdate(run, operation, absolute);
	}
}

/** Run one operation in memory. An error names the file, the operation, and the next step. */
async function stageOperation(run: PatchRun, operation: PatchOperation): Promise<PatchStep> {
	try {
		return await stageBy(run, operation);
	} catch (error) {
		assertLive(run.signal);
		const reason = error instanceof Error ? error.message : String(error);
		const where = `${operation.path} (${OPERATION_NAMES[operation.kind]})`;
		throw new Error(
			`Could not apply patch to ${where}: ${reason}\nNothing was written. Read the file and send the patch again.`,
			{ cause: error },
		);
	}
}

/** Write each staged file, and delete each staged deletion. A deletion of a file that is not there does nothing. */
async function commitPatch(run: PatchRun): Promise<void> {
	for (const [absolute, { path, content }] of run.staged) {
		const done =
			content === null
				? await run.env.remove(absolute, { force: true }, run.signal)
				: await run.env.writeFile(absolute, content, run.signal);
		if (!done.ok) {
			throw new Error(
				`Could not apply patch to ${path}. Error code: ${done.error.code}. Earlier files of the patch may be written.`,
				{ cause: done.error },
			);
		}
	}
}

/** The line of the result for one operation: `A path`, `M path`, `D path`, or `M path -> to`. */
function summaryLine({ path, action, to }: PatchStep['file']): string {
	const letters = { add: 'A', update: 'M', delete: 'D', move: 'M' } as const;
	return `${letters[action]} ${path}${to === undefined ? '' : ` -> ${to}`}`;
}

export async function applyPatchFiles(
	env: WorkspaceEnv,
	{ input }: ApplyPatchParams,
	signal: AbortSignal | undefined,
): Promise<ToolResult<ApplyPatchDetails>> {
	assertLive(signal);
	let operations: PatchOperation[];
	try {
		operations = parsePatch(input);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Invalid patch: ${reason}\nNothing was written. Fix the patch and send it again.`,
			{
				cause: error,
			},
		);
	}
	const run: PatchRun = { env, staged: new Map(), signal };
	const steps: PatchStep[] = [];
	for (const operation of operations) steps.push(await stageOperation(run, operation));
	assertLive(signal);
	await commitPatch(run);
	assertLive(signal);
	return text(`Applied patch: ${steps.map((step) => summaryLine(step.file)).join(', ')}`, {
		files: steps.map((step) => step.file),
		patch: steps.map((step) => step.patch).join(''),
	});
}

/** The argument forms that a model gives: the patch as a bare string, and `patch` for `input`. */
export function prepareApplyPatchArguments(input: unknown): ApplyPatchParams {
	if (typeof input === 'string') return { input };
	if (typeof input !== 'object' || input === null) return input as ApplyPatchParams;
	const { patch, ...rest } = input as Record<string, unknown>;
	return (
		typeof patch === 'string' && rest.input === undefined ? { ...rest, input: patch } : input
	) as ApplyPatchParams;
}
