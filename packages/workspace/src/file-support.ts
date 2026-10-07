/**
 * What the file tools share: the thrown error of a failed port call, the
 * check of an abort signal, the text result, the resolution of a tool path,
 * and the read of a file that a tool may change.
 */

import type { ToolResult } from '@ambionframework/ambion';
import type { WorkspaceEnv } from './backend.ts';
import type { FileError, Result } from './port.ts';

/** The value of a result, or its error thrown. */
export function value<T>(result: Result<T, FileError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

export function assertLive(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error('Operation aborted');
}

export function text(message: string): ToolResult<undefined>;
export function text<D>(message: string, details: D): ToolResult<D>;
export function text(message: string, details?: unknown): ToolResult {
	return { content: [{ type: 'text', text: message }], details };
}

/** An error for a file that the tool could not reach, with the cause. */
export function accessError(path: string, error: FileError): Error {
	return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}

/** The absolute path of a tool path. A leading `@` and the Unicode spaces of a pasted path go. */
export async function resolvePath(
	env: WorkspaceEnv,
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	const plain = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
	return value(await env.absolutePath(plain.startsWith('@') ? plain.slice(1) : plain, signal));
}

/** The content of a file that `edit` may change, or the error that names why it may not. */
export async function readEditable(
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
