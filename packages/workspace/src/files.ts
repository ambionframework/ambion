/**
 * `WorkspaceFiles` over the bash owner: what a SQL backend reaches of the
 * bash backend.
 *
 * Each call is one operation on the bash owner, as the calling agent, so it
 * takes its place in the same queue as every file tool. A SQL operation may
 * wait on the bash owner through this facade. A bash operation never waits
 * on the SQL owner, so the two owners never wait on each other.
 *
 * `writeFile` appends the chunks to a temporary file, then renames it onto
 * the target. The target changes only after every chunk lands.
 */

import { posix } from 'node:path';
import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';
import type { WorkspaceFiles } from './sql-backend.ts';

/** `path` as an absolute path on `env`. */
async function absolutePath(env: ExecutionEnv, path: string, context: Context): Promise<string> {
	const resolved = await env.absolutePath(path, context);
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

/** Append every chunk to `temp`. */
async function appendAll(
	env: ExecutionEnv,
	temp: string,
	chunks: Iterable<string> | AsyncIterable<string>,
	context: Context,
): Promise<void> {
	for await (const chunk of chunks) {
		const appended = await env.appendFile(temp, chunk, context);
		if (!appended.ok) throw appended.error;
	}
}

/** Write `chunks` to a temporary file, and rename it onto `path`. */
async function writeThrough(
	env: ExecutionEnv,
	path: string,
	chunks: Iterable<string> | AsyncIterable<string>,
	context: Context,
): Promise<string> {
	const target = await absolutePath(env, path, context);
	const made = await env.createDir(posix.dirname(target), { recursive: true }, context);
	if (!made.ok) throw made.error;
	const temp = await env.createTempFile({ suffix: '.part' }, context);
	if (!temp.ok) throw temp.error;
	try {
		await appendAll(env, temp.value, chunks, context);
		const moved = await env.renameFile(temp.value, target, context);
		if (!moved.ok) throw moved.error;
	} finally {
		await env.remove(temp.value, { force: true }, context);
	}
	return target;
}

/** The files of `agent` on the bash backend, through the bash owner's `use`. */
export function workspaceFiles(
	use: WorkspaceResource<WorkspaceEnv>['use'],
	agent: WorkspaceAgent,
): WorkspaceFiles {
	const files: WorkspaceFiles = {
		writeFile: (path, chunks, context) =>
			use(agent, (env) => writeThrough(env, path, chunks, context), context.abortSignal),
	};
	return Object.freeze(files);
}
