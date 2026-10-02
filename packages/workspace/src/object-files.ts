/**
 * The default object backend: one file for each digest under
 * `layout.snapshots`, on the bash backend, written as the mirror agent.
 *
 * A workspace opens it when `WorkspaceBackends.objects` is absent. Each
 * operation runs on the bash resource as the mirror agent, so the object
 * resource may wait on the bash resource, and no bash operation waits on
 * the object resource. A put writes a temporary file beside the target and renames it, so
 * no reader sees a part, and a put of a digest the folder holds writes
 * nothing. On a workstation, the host account alone writes the folder.
 */

import { posix } from 'node:path';
import type { WorkspaceEnv } from './backend.ts';
import { randomName } from './execution-env.ts';
import type { ObjectBackend, ObjectEnv } from './object-backend.ts';
import { assertDigest, assertObjectSize } from './object-rules.ts';
import type { FileError, Result } from './port.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/** What the file store writes through: the bash resource, the mirror agent, and the folder. */
export interface FileObjectOptions {
	readonly bash: WorkspaceResource<WorkspaceEnv>['use'];
	readonly mirrorAgent: WorkspaceAgent;
	readonly root: string;
}

/** The value of a result, or the thrown error with `what` in front of its message. */
export function unwrap<T>(result: Result<T, FileError>, what: string): T {
	if (result.ok) return result.value;
	if (result.error.code === 'aborted') throw result.error;
	throw new Error(`${what}: ${result.error.message}`);
}

/** Write `bytes` to `target` once, through a temporary file in the same folder. */
async function putFile(
	env: WorkspaceEnv,
	target: string,
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<void> {
	if (unwrap(await env.exists(target, signal), `Cannot read ${target}`)) return;
	unwrap(
		await env.createDir(posix.dirname(target), { recursive: true }, signal),
		`Cannot write ${target}`,
	);
	const temp = `${target}.${randomName()}.part`;
	try {
		unwrap(await env.writeFile(temp, bytes, signal), `Cannot write ${target}`);
		unwrap(await env.renameFile(temp, target, signal), `Cannot write ${target}`);
	} finally {
		// The cleanup runs with no signal: an aborted call still removes its temporary file.
		await env.remove(temp, { force: true });
	}
}

/** The bytes of `target`, or undefined when the folder holds no such file. */
async function getFile(
	env: WorkspaceEnv,
	target: string,
	signal?: AbortSignal,
): Promise<Uint8Array | undefined> {
	const info = await env.fileInfo(target, signal);
	if (!info.ok && info.error.code === 'not_found') return undefined;
	const found = unwrap(info, `Cannot read ${target}`);
	if (found.kind !== 'file') throw new Error(`${target} is not a file.`);
	assertObjectSize(target, found.size);
	const bytes = unwrap(await env.readBinaryFile(target, signal), `Cannot read ${target}`);
	assertObjectSize(target, bytes.byteLength);
	return bytes;
}

/** The file store over the bash resource at `root`. Every agent reaches the one folder. */
export function fileObjectBackend(options: FileObjectOptions): ObjectBackend {
	const { bash, mirrorAgent, root } = options;
	const env: ObjectEnv = {
		put: async (digest, bytes, signal) => {
			assertDigest(digest);
			assertObjectSize(digest, bytes.byteLength);
			await bash(
				mirrorAgent,
				(files) => putFile(files, posix.join(root, digest), bytes, signal),
				signal,
			);
		},
		get: async (digest, signal) => {
			assertDigest(digest);
			return bash(mirrorAgent, (files) => getFile(files, posix.join(root, digest), signal), signal);
		},
		cleanup: async () => undefined,
	};
	return Object.freeze({ label: root, connect: async () => env });
}
