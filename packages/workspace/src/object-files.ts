/**
 * The default object backend: one file for each digest under
 * `layout.snapshots`, on the bash backend, written as the host agent.
 *
 * A workspace opens it when `WorkspaceBackends.objects` is absent. Each
 * operation runs on the bash owner as the host agent, so the object owner
 * may wait on the bash owner, and no bash operation waits on the object
 * owner. A put writes a temporary file beside the target and renames it, so
 * no reader sees a part, and a put of a digest the folder holds writes
 * nothing. On a workstation, the host account alone writes the folder.
 */

import { posix } from 'node:path';
import {
	BACKGROUND_CONTEXT,
	type Context,
	type ExecutionEnv,
	type FileError,
	type Result,
	withAbortSignal,
} from '@earendil-works/pi-agent-core';
import type { WorkspaceEnv } from './backend.ts';
import { randomName } from './execution-env.ts';
import type { ObjectBackend, ObjectEnv } from './object-backend.ts';
import { assertDigest, assertObjectSize } from './object-rules.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/** What the file store writes through: the bash owner, the host agent, and the folder. */
export interface FileObjectOptions {
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly host: WorkspaceAgent;
	readonly root: string;
}

/** The context of one operation: the caller's signal, when it has one. */
export function contextOf(signal: AbortSignal | undefined): Context {
	return signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
}

/** The value of a result, or the thrown error with `what` in front of its message. */
export function unwrap<T>(result: Result<T, FileError>, what: string): T {
	if (result.ok) return result.value;
	if (result.error.code === 'aborted') throw result.error;
	throw new Error(`${what}: ${result.error.message}`);
}

/** Write `bytes` to `target` once, through a temporary file in the same folder. */
async function putFile(
	env: ExecutionEnv,
	target: string,
	bytes: Uint8Array,
	context: Context,
): Promise<void> {
	if (unwrap(await env.exists(target, context), `Cannot read ${target}`)) return;
	unwrap(
		await env.createDir(posix.dirname(target), { recursive: true }, context),
		`Cannot write ${target}`,
	);
	const temp = `${target}.${randomName()}.part`;
	try {
		unwrap(await env.writeFile(temp, bytes, context), `Cannot write ${target}`);
		unwrap(await env.renameFile(temp, target, context), `Cannot write ${target}`);
	} finally {
		// The cleanup runs over its own context: an aborted call still removes its temporary file.
		await env.remove(temp, { force: true }, BACKGROUND_CONTEXT);
	}
}

/** The bytes of `target`, or undefined when the folder holds no such file. */
async function getFile(
	env: ExecutionEnv,
	target: string,
	context: Context,
): Promise<Uint8Array | undefined> {
	const info = await env.fileInfo(target, context);
	if (!info.ok && info.error.code === 'not_found') return undefined;
	const found = unwrap(info, `Cannot read ${target}`);
	if (found.kind !== 'file') throw new Error(`${target} is not a file.`);
	assertObjectSize(target, found.size);
	const bytes = unwrap(await env.readBinaryFile(target, context), `Cannot read ${target}`);
	assertObjectSize(target, bytes.byteLength);
	return bytes;
}

/** The file store over the bash owner at `root`. Every agent reaches the one folder. */
export function fileObjectBackend(options: FileObjectOptions): ObjectBackend {
	const { shell, host, root } = options;
	const env: ObjectEnv = {
		put: async (digest, bytes, signal) => {
			assertDigest(digest);
			assertObjectSize(digest, bytes.byteLength);
			const context = contextOf(signal);
			await shell(
				host,
				(files) => putFile(files, posix.join(root, digest), bytes, context),
				signal,
			);
		},
		get: async (digest, signal) => {
			assertDigest(digest);
			const context = contextOf(signal);
			return shell(host, (files) => getFile(files, posix.join(root, digest), context), signal);
		},
		cleanup: async () => undefined,
	};
	return Object.freeze({ store: root, connect: async () => env });
}
