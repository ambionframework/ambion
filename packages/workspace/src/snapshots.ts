/**
 * Snapshots: a stable, immutable ref to the bytes of a workspace file.
 *
 * `snapshot` reads each file as the agent that asks, on the bash owner, and
 * hashes its bytes with SHA-256. It then puts the bytes under their digest
 * on the object owner, as the host agent. The ref is the kernel's snapshot
 * URI: `ambion://workspace/<name>/snapshot/<digest>/<path>`. The same bytes
 * give the same object.
 *
 * The digest names the bytes. A later change to the file does not change
 * the object. `readSnapshot` and `restore` check the bytes against the digest
 * through `verified`, so an object that changed in its store is refused,
 * whatever the store.
 *
 * The operations run in turn and never inside each other: `snapshot` reads
 * on the bash owner, then puts on the object owner; `restore` gets on the
 * object owner, then writes on the bash owner.
 */

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
	type AmbionTool,
	defineTool,
	parseSnapshotUri,
	REF_LIMITS,
	snapshotUri,
	type ToolContext,
} from '@ambionframework/ambion';
import type { Context, ExecutionEnv } from '@earendil-works/pi-agent-core';
import { type Static, Type } from 'typebox';
import type { WorkspaceEnv } from './backend.ts';
import type { ObjectEnv } from './object-backend.ts';
import { contextOf, unwrap } from './object-files.ts';
import { assertObjectSize, MAX_OBJECT_BYTES } from './object-rules.ts';
import type { WorkspaceAgent, WorkspaceResource } from './resource.ts';

/**
 * The most files one snapshot takes, and the most bytes one file holds. A
 * message carries at most `REF_LIMITS.count` refs, so one snapshot gives at
 * most one message of refs. A file holds at most what one object holds, the
 * limit of one S3 PutObject. The call reads, hashes, and puts one file at a
 * time, so it holds one file in memory.
 */
export const SNAPSHOT_LIMITS = { count: REF_LIMITS.count, bytes: MAX_OBJECT_BYTES } as const;

/** Who reads the files of a snapshot, and the signal that stops it. */
export interface SnapshotOptions {
	/**
	 * The agent that reads the files. The default is the workspace's host
	 * agent. On a backend with one account for each agent, name the agent
	 * whose home holds the files.
	 */
	readonly agent?: WorkspaceAgent;
	readonly signal?: AbortSignal;
}

/** The two owners a snapshot runs on, the workspace name, and the host agent. */
export interface SnapshotStore {
	/** The workspace name, the first part of every ref. */
	readonly workspace: string;
	/** The agent that puts and gets every object. */
	readonly host: WorkspaceAgent;
	readonly shell: WorkspaceResource<WorkspaceEnv>['use'];
	readonly objects: WorkspaceResource<ObjectEnv>['use'];
}

/** One file to snapshot: the absolute path that named it, and the path to read. */
interface Found {
	readonly path: string;
	readonly canonical: string;
}

/**
 * Find the file at `path` as the agent of `env`: a file, of at most one
 * object's bytes, whose ref fits the ref grammar. A symbolic link names its
 * file.
 */
async function find(
	store: SnapshotStore,
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<Found> {
	const absolute = unwrap(await env.absolutePath(path, context), `Cannot read ${path}`);
	const canonical = unwrap(await env.canonicalPath(absolute, context), `Cannot read ${absolute}`);
	const info = unwrap(await env.fileInfo(canonical, context), `Cannot read ${absolute}`);
	if (info.kind !== 'file') throw new Error(`${absolute} is not a file.`);
	assertObjectSize(absolute, info.size);
	// Every digest has 64 digits, so a placeholder gives the length of the ref.
	checkRef(snapshotUri(store.workspace, '0'.repeat(64), absolute), absolute);
	return { path: absolute, canonical };
}

/** The bytes of a found file. The file can grow between the find and the read. */
async function read(env: ExecutionEnv, file: Found, context: Context): Promise<Uint8Array> {
	const bytes = unwrap(
		await env.readBinaryFile(file.canonical, context),
		`Cannot read ${file.path}`,
	);
	assertObjectSize(file.path, bytes.byteLength);
	return bytes;
}

/** The SHA-256 digest of `bytes`, as 64 lowercase hex digits. */
function digestOf(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Store verified received bytes under the same immutable object/ref contract as snapshots. */
export async function retainSnapshotBuffer(
	store: SnapshotStore,
	path: string,
	bytes: Uint8Array,
	signal?: AbortSignal,
): Promise<{ readonly digest: string; readonly ref: string }> {
	assertObjectSize(path, bytes.byteLength);
	const digest = digestOf(bytes);
	const ref = snapshotUri(store.workspace, digest, path);
	checkRef(ref, path);
	await store.objects(store.host, (env) => env.put(digest, bytes, signal), signal);
	return { digest, ref };
}

/** Refuse a list of paths that is empty, too long, or not strings. */
function checkPaths(paths: readonly unknown[]): asserts paths is readonly string[] {
	if (paths.length === 0) throw new Error('A snapshot needs at least one path.');
	if (paths.length > SNAPSHOT_LIMITS.count)
		throw new Error(
			`A snapshot takes at most ${SNAPSHOT_LIMITS.count} paths, and the call names ${paths.length}.`,
		);
	if (paths.some((path) => typeof path !== 'string' || path.trim() === ''))
		throw new Error('Each snapshot path must be a nonblank string.');
}

/** Refuse a ref past the length of a ref. */
function checkRef(ref: string, path: string): void {
	if (ref.length > REF_LIMITS.length)
		throw new Error(
			`The ref of ${path} has ${ref.length} characters, and a ref has at most ${REF_LIMITS.length}.`,
		);
}

/** Find the file of each path, in order. A message holds each ref once, so two paths of one file are refused. */
async function findAll(
	store: SnapshotStore,
	env: ExecutionEnv,
	paths: readonly string[],
	context: Context,
): Promise<Found[]> {
	const files: Found[] = [];
	for (const path of paths) {
		const file = await find(store, env, path, context);
		if (files.some((other) => other.path === file.path))
			throw new Error(`The snapshot names ${file.path} twice. Name each file once.`);
		files.push(file);
	}
	return files;
}

/**
 * Snapshot the files at `paths`, and give one ref for each, in order. A
 * relative path resolves against the reading agent's working directory.
 * The call finds every file before it reads one, so a path that is not a
 * file, is too large, has too long a ref, or names a file twice stores
 * nothing. It then reads,
 * hashes, and puts one file at a time.
 */
export async function takeSnapshot(
	store: SnapshotStore,
	paths: readonly string[],
	options: SnapshotOptions = {},
): Promise<readonly string[]> {
	checkPaths(paths);
	const { signal } = options;
	const context = contextOf(signal);
	const reader = options.agent ?? store.host;
	const found = await store.shell(reader, (env) => findAll(store, env, paths, context), signal);
	const refs: string[] = [];
	for (const file of found) {
		const bytes = await store.shell(reader, (env) => read(env, file, context), signal);
		const saved = await retainSnapshotBuffer(store, file.path, bytes, signal);
		refs.push(saved.ref);
	}
	return Object.freeze(refs);
}

/** `bytes` when their SHA-256 is `digest`, or a thrown error that names `ref`. */
function verified(ref: string, digest: string, bytes: Uint8Array | undefined): Uint8Array {
	if (bytes === undefined)
		throw new Error(
			`The object store holds no bytes for ${ref}. Ask its author for a new snapshot.`,
		);
	if (digestOf(bytes) !== digest)
		throw new Error(
			`The bytes of ${ref} changed after the snapshot, and the workspace refuses them.`,
		);
	return bytes;
}

/** The parts of a snapshot ref of this workspace, or a thrown error. */
function namedBy(store: SnapshotStore, ref: string): { digest: string; path: string } {
	const named = parseSnapshotUri(ref);
	if (named === undefined)
		throw new Error(`${ref} is not a snapshot ref. Give the ref that snapshot gave.`);
	if (named.workspace !== store.workspace)
		throw new Error(`${ref} names the workspace '${named.workspace}', not '${store.workspace}'.`);
	return named;
}

/**
 * The bytes a snapshot ref names, from the object store. The call refuses a
 * ref of another workspace, a missing object, and bytes that no longer
 * match the digest.
 */
export async function readSnapshot(
	store: SnapshotStore,
	ref: string,
	options: { readonly signal?: AbortSignal } = {},
): Promise<Uint8Array> {
	const { digest } = namedBy(store, ref);
	const bytes = await store.objects(
		store.host,
		(env) => env.get(digest, options.signal),
		options.signal,
	);
	return verified(ref, digest, bytes);
}

// -- the tool ------------------------------------------------------------------

const snapshotSchema = Type.Object({
	paths: Type.Array(
		Type.String({ description: 'A file path, absolute or relative to your home.' }),
		{
			minItems: 1,
			maxItems: SNAPSHOT_LIMITS.count,
			description: 'The files to snapshot.',
		},
	),
});

type SnapshotParams = Static<typeof snapshotSchema>;

/** What `snapshot` gives in `details`. */
export interface SnapshotDetails {
	refs: readonly string[];
}

/** Build the `snapshot` tool. Each call reads the files as the calling agent. */
export function createSnapshotTool(store: SnapshotStore): AmbionTool {
	return defineTool({
		name: 'snapshot',
		label: 'Snapshot',
		description:
			'Freeze files of the workspace and give one ref for each. A ref names the bytes the file holds now, and a later change to the file does not change them. Put the refs in the refs of a say to cite the files.',
		parameters: snapshotSchema,
		execute: async (params: SnapshotParams, ctx: ToolContext) => {
			const refs = await takeSnapshot(store, params.paths, {
				agent: ctx.agent,
				...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
			});
			const lines = params.paths.map((path, index) => `${path}: ${refs[index]}`);
			return {
				content: [{ type: 'text' as const, text: lines.join('\n') }],
				details: { refs } satisfies SnapshotDetails,
			};
		},
	});
}

const restoreSchema = Type.Object({
	ref: Type.String({ description: 'A snapshot ref of this workspace.' }),
	path: Type.Optional(
		Type.String({
			description: 'Where to write the bytes. The default is ~/snapshots/<digest>/<name>.',
		}),
	),
});

type RestoreParams = Static<typeof restoreSchema>;

/** What `restore` gives in `details`. */
interface RestoreDetails {
	ref: string;
	path: string;
	bytes: number;
}

/** Write `bytes` to `path` as the agent of `env`, and give the absolute path. */
async function writeFile(
	env: ExecutionEnv,
	path: string,
	bytes: Uint8Array,
	context: Context,
): Promise<string> {
	const target = unwrap(await env.absolutePath(path, context), `Cannot write ${path}`);
	unwrap(
		await env.createDir(posix.dirname(target), { recursive: true }, context),
		`Cannot write ${target}`,
	);
	unwrap(await env.writeFile(target, bytes, context), `Cannot write ${target}`);
	return target;
}

/**
 * Put the bytes of a snapshot ref in the files of `agent`, at `path` or at
 * `~/snapshots/<digest>/<name>`, and give the absolute path.
 */
async function restoreSnapshot(
	store: SnapshotStore,
	agent: WorkspaceAgent,
	request: { readonly ref: string; readonly path?: string },
	signal?: AbortSignal,
): Promise<RestoreDetails> {
	const { digest, path: named } = namedBy(store, request.ref);
	const bytes = verified(
		request.ref,
		digest,
		await store.objects(store.host, (env) => env.get(digest, signal), signal),
	);
	const path = request.path ?? `~/snapshots/${digest}/${posix.basename(named)}`;
	const context = contextOf(signal);
	const target = await store.shell(agent, (env) => writeFile(env, path, bytes, context), signal);
	return { ref: request.ref, path: target, bytes: bytes.byteLength };
}

/** Build the `restore` tool. Each call writes the bytes as the calling agent. */
export function createRestoreTool(store: SnapshotStore): AmbionTool {
	return defineTool({
		name: 'restore',
		label: 'Restore a snapshot',
		description:
			'Put the bytes of a snapshot ref in a file of your own, and give its path. The bytes are the ones the file held at the snapshot.',
		parameters: restoreSchema,
		execute: async (params: RestoreParams, ctx) => {
			const details = await restoreSnapshot(
				store,
				ctx.agent,
				{ ref: params.ref, ...(params.path === undefined ? {} : { path: params.path }) },
				ctx.signal,
			);
			return {
				content: [
					{
						type: 'text' as const,
						text: `Wrote the ${details.bytes} bytes of ${details.ref} to ${details.path}.`,
					},
				],
				details,
			};
		},
	});
}

/** The note that tells every agent how to cite a file, and how to read one that is cited. */
export function snapshotGuidance(workspace: string): string {
	return [
		`To cite a file, call snapshot with its path, and put the ref it gives in the refs of a`,
		`say. The ref has the form ambion://workspace/${workspace}/snapshot/<digest>/<path>. It`,
		`names the bytes the file holds at the snapshot, and a later change to the file does not`,
		`change them. To read a cited snapshot, call restore with its ref: restore puts the bytes in`,
		`a file of your own and gives its path.`,
	].join('\n');
}
