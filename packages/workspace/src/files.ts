/**
 * `WorkspaceFiles` over the bash resource: what a SQL backend reaches of
 * the bash backend.
 *
 * Each call is one operation on the bash resource, as the calling agent, so
 * it takes its place in the same queue as every file tool. A SQL operation
 * may wait on the bash resource through this facade. A bash operation never
 * waits on the SQL resource, so the two resources never wait on each other.
 *
 * `writeFile` appends the chunks to a temporary file beside the target,
 * then renames it onto the target. The target changes only after every
 * chunk lands. The temporary file shares the target's folder, so the rename
 * stays on one filesystem: a server can mount `/tmp` as a filesystem of its
 * own, and a rename across two filesystems fails.
 *
 * `readFile` follows a symbolic link to its file, and checks the size of the
 * file before it reads, so a large file never enters memory. A file error
 * comes back as a message for the agent, and an abort rejects.
 */

import { posix } from 'node:path';
import type { WorkspaceEnv } from './backend.ts';
import { randomName } from './execution-env.ts';
import { formatBytes } from './format-bytes.ts';
import type { FileError } from './port.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';
import type { WorkspaceFiles, WorkspaceRead } from './sql-backend.ts';

/** `path` as an absolute path on `env`. */
async function absolutePath(
	env: WorkspaceEnv,
	path: string,
	signal?: AbortSignal,
): Promise<string> {
	const resolved = await env.absolutePath(path, signal);
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

/** Append every chunk to `temp`. */
async function appendAll(
	env: WorkspaceEnv,
	temp: string,
	chunks: Iterable<string> | AsyncIterable<string>,
	signal?: AbortSignal,
): Promise<void> {
	for await (const chunk of chunks) {
		const appended = await env.appendFile(temp, chunk, signal);
		if (!appended.ok) throw appended.error;
	}
}

/** Write `chunks` to a temporary file beside `path`, and rename it onto `path`. */
async function writeThrough(
	env: WorkspaceEnv,
	path: string,
	chunks: Iterable<string> | AsyncIterable<string>,
	signal?: AbortSignal,
): Promise<string> {
	const target = await absolutePath(env, path, signal);
	const made = await env.createDir(posix.dirname(target), { recursive: true }, signal);
	if (!made.ok) throw made.error;
	const temp = `${target}.${randomName()}.part`;
	try {
		const started = await env.writeFile(temp, '', signal);
		if (!started.ok) throw started.error;
		await appendAll(env, temp, chunks, signal);
		const moved = await env.renameFile(temp, target, signal);
		if (!moved.ok) throw moved.error;
	} finally {
		// The cleanup runs with no signal: an aborted call still removes its temporary file.
		await env.remove(temp, { force: true });
	}
	return target;
}

/** The refusal of a file that holds more than `maxBytes`. */
function tooLarge(path: string, bytes: number, maxBytes: number): WorkspaceRead {
	return {
		ok: false,
		message: `${path} holds ${formatBytes(bytes)}, and an import reads at most ${formatBytes(maxBytes)}.`,
	};
}

/** Read `path` when it is a file of at most `maxBytes` bytes. */
async function readThrough(
	env: WorkspaceEnv,
	path: string,
	maxBytes: number,
	signal?: AbortSignal,
): Promise<WorkspaceRead> {
	const target = await absolutePath(env, path, signal);
	const failed = (error: FileError): WorkspaceRead => {
		if (error.code === 'aborted') throw error;
		return { ok: false, message: `Cannot read ${target}: ${error.message}` };
	};
	const canonical = await env.canonicalPath(target, signal);
	if (!canonical.ok) return failed(canonical.error);
	const info = await env.fileInfo(canonical.value, signal);
	if (!info.ok) return failed(info.error);
	if (info.value.kind !== 'file') return { ok: false, message: `${target} is not a file.` };
	if (info.value.size > maxBytes) return tooLarge(target, info.value.size, maxBytes);
	const read = await env.readTextFile(canonical.value, signal);
	if (!read.ok) return failed(read.error);
	// The file can grow between the check and the read.
	const bytes = Buffer.byteLength(read.value);
	if (bytes > maxBytes) return tooLarge(target, bytes, maxBytes);
	return { ok: true, path: target, text: read.value };
}

/** The files of `agent` on the bash backend, through the `use` of the bash resource. */
export function workspaceFiles(
	use: WorkspaceResource<WorkspaceEnv>['use'],
	agent: WorkspaceAgent,
): WorkspaceFiles {
	const files: WorkspaceFiles = {
		readFile: (path, maxBytes, signal) =>
			use(agent, (env) => readThrough(env, path, maxBytes, signal), signal),
		writeFile: (path, chunks, signal) =>
			use(agent, (env) => writeThrough(env, path, chunks, signal), signal),
	};
	return Object.freeze(files);
}
