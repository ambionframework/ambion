/**
 * The object backend: where the workspace keeps the bytes of each snapshot.
 *
 * A workspace always has one. `WorkspaceBackends.objects` names it, and
 * when it is absent the workspace opens a file store at `layout.snapshots`
 * on the bash backend. The workspace hashes the bytes with SHA-256 and
 * passes the digest. The backend forms its own key from the digest, so the
 * same bytes have one object. The workspace checks the digest on every
 * read, so a backend promises storage alone.
 *
 * This module holds types only. `docs/workspace.md` states the contract.
 */

import type { ResourceBackend, ResourceEnv } from './resource.ts';

/** The SHA-256 of the bytes, as 64 lowercase hex digits. A backend refuses any other key. */
export type ObjectDigest = string;

/** One environment over the object backend. Every agent reaches the same store. */
export interface ObjectEnv extends ResourceEnv {
	/** Store `bytes` under `digest`. A put of a digest the store holds writes nothing. */
	put(digest: ObjectDigest, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
	/** The bytes under `digest`, or `undefined` when the store has none. */
	get(digest: ObjectDigest, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

/** The object backend of a workspace. */
export interface ObjectBackend extends ResourceBackend<ObjectEnv> {
	/** The store that errors and the guidance name, with no credential: a folder or a bucket URL. */
	readonly store: string;
}
