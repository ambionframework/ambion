/**
 * The refs a message cites and the URIs the kernel defines.
 *
 * A ref is one absolute URI. The room checks its grammar and never reads
 * behind it. The kernel owns the `ambion` scheme and defines four forms:
 * a room, one message of a room, one snapshot of a workspace file, and one
 * commit of a workspace repository. The kernel only reads and builds these
 * forms. A workspace makes a snapshot and keeps its bytes, and its git
 * backend holds the commit.
 */
import { assertRoomName } from './define.ts';
import { isName } from './names.ts';
import type { Seq } from './types.ts';

/** The most refs one message carries, and the most characters one ref has. */
export const REF_LIMITS = { count: 16, length: 2048 } as const;

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):(.+)$/s;
const FORBIDDEN = /[\s\p{Cc}]/u;
const CONTROL = /\p{Cc}/u;
const ROOM_URI = /^ambion:\/\/room\/([^/]+)(?:\/message\/([1-9][0-9]*))?$/;
const SNAPSHOT_URI = /^ambion:\/\/workspace\/([^/]+)\/snapshot\/([0-9a-f]{64})(\/.+)$/;
const DIGEST = /^[0-9a-f]{64}$/;
const COMMIT_URI =
	/^ambion:\/\/workspace\/([^/]+)\/repo\/([^/]+\/[^/]+)(?:\/(branch|tag)\/([^/]+))?\/commit\/([0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What a room URI names. `message` is the seq of the message it names. */
export interface RoomUri {
	readonly room: string;
	readonly message?: Seq;
}

/**
 * What a snapshot URI names: the SHA-256 digest of the bytes, as 64
 * lowercase hex digits, and the absolute workspace path the bytes came from.
 * The digest names the bytes. The path tells a reader what the file was.
 */
export interface SnapshotUri {
	readonly workspace: string;
	readonly digest: string;
	readonly path: string;
}

/**
 * What a commit URI names: one commit of a repository of a workspace, by
 * its full hash of 40 or 64 lowercase hex digits. `branch` or `tag` is the
 * name that pointed at the commit when the ref was made. The hash names
 * the commit, so the ref keeps its meaning when the branch moves.
 */
export interface CommitUri {
	readonly workspace: string;
	/** The repository ID, `<namespace>/<name>`. */
	readonly repository: string;
	readonly commit: string;
	readonly branch?: string;
	readonly tag?: string;
}

/** The name a commit ref records: the branch or the tag that pointed at the commit. */
export type CommitVia = { readonly branch: string } | { readonly tag: string };

/** The reason for a refusal, one sentence for every entry point. */
const GRAMMAR = `A ref is one absolute URI with a scheme, at most ${REF_LIMITS.length} characters, at most ${REF_LIMITS.count} per message, no duplicates; an ambion: ref names a room, a message, a workspace snapshot, or a commit.`;

/** A ref is an absolute URI. An `ambion` ref must be a canonical kernel URI. */
export function isRef(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > REF_LIMITS.length) return false;
	if (FORBIDDEN.test(value)) return false;
	const match = SCHEME.exec(value);
	if (match === null) return false;
	if (match[1]?.toLowerCase() !== 'ambion') return true;
	return (
		parseRoomUri(value) !== undefined ||
		parseSnapshotUri(value) !== undefined ||
		parseCommitUri(value) !== undefined
	);
}

/** The reason a list of refs is refused, or undefined when the room accepts it. */
export function refsRefusal(refs: unknown): string | undefined {
	if (!Array.isArray(refs)) return `refs must be an array. ${GRAMMAR}`;
	if (refs.length > REF_LIMITS.count) return `refs holds ${refs.length} entries. ${GRAMMAR}`;
	const seen = new Set<unknown>();
	for (const [index, ref] of refs.entries()) {
		if (!isRef(ref)) return `refs[${index}] is not a ref. ${GRAMMAR}`;
		if (seen.has(ref)) return `refs[${index}] repeats an earlier ref. ${GRAMMAR}`;
		seen.add(ref);
	}
	return undefined;
}

/** The URI of a room. */
export function roomUri(room: string): string {
	assertRoomName(room);
	return `ambion://room/${room}`;
}

/** The URI of the message at `seq`. */
export function messageUri(room: string, seq: Seq): string {
	if (!Number.isSafeInteger(seq) || seq < 1)
		throw new RangeError('Message reference must be a positive safe integer.');
	return `${roomUri(room)}/message/${seq}`;
}

/** Read a canonical room URI. Any other string returns undefined. */
export function parseRoomUri(uri: string): RoomUri | undefined {
	const match = ROOM_URI.exec(uri);
	const room = match?.[1];
	if (room === undefined || !isName(room)) return undefined;
	const seq = match?.[2];
	if (seq === undefined) return { room };
	const message = Number(seq);
	return Number.isSafeInteger(message) ? { room, message } : undefined;
}

/**
 * The parts of an absolute path, or undefined when the path is not one
 * canonical absolute path. A canonical path has no empty part, no `.`, no
 * `..`, and no control character, so a decoded part never carries a NUL, a
 * newline, or a terminal escape.
 */
function pathParts(path: string): string[] | undefined {
	if (!path.startsWith('/')) return undefined;
	const parts = path.slice(1).split('/');
	const bad = parts.some(
		(part) => part === '' || part === '.' || part === '..' || CONTROL.test(part),
	);
	return bad ? undefined : parts;
}

/** The path as the URI writes it: each part percent-encoded. */
function encodedPath(parts: readonly string[]): string {
	return parts.map((part) => `/${encodeURIComponent(part)}`).join('');
}

/**
 * The URI of the snapshot of the file at `path` in the workspace
 * `workspace`, with the SHA-256 digest `digest`. A workspace makes the
 * snapshot; this function only writes its URI.
 */
export function snapshotUri(workspace: string, digest: string, path: string): string {
	if (!isName(workspace))
		throw new RangeError(
			`Invalid workspace name '${workspace}': names are lowercase, alphanumeric plus dashes.`,
		);
	if (!DIGEST.test(digest))
		throw new RangeError('A snapshot digest is 64 lowercase hex digits of SHA-256.');
	const parts = pathParts(path);
	if (parts === undefined)
		throw new RangeError(
			`A snapshot path must be a canonical absolute path with no control character: ${JSON.stringify(path)}.`,
		);
	return `ambion://workspace/${workspace}/snapshot/${digest}${encodedPath(parts)}`;
}

/** Decode one percent-encoded part, or undefined when it is not valid. */
function decodedPart(part: string): string | undefined {
	try {
		return decodeURIComponent(part);
	} catch {
		return undefined;
	}
}

/**
 * Read a canonical snapshot URI. Any other string returns undefined. The
 * path must be in the one form that `snapshotUri` writes, so one file and
 * one digest have one URI.
 */
export function parseSnapshotUri(uri: string): SnapshotUri | undefined {
	const match = SNAPSHOT_URI.exec(uri);
	const [, workspace, digest, encoded] = match ?? [];
	if (workspace === undefined || digest === undefined || encoded === undefined) return undefined;
	if (!isName(workspace)) return undefined;
	const decoded = encoded.slice(1).split('/').map(decodedPart);
	if (decoded.some((part) => part === undefined)) return undefined;
	// An encoded `/` decodes into a part, and the encoding below then differs.
	const path = `/${decoded.join('/')}`;
	const parts = pathParts(path);
	if (parts === undefined || encodedPath(parts) !== encoded) return undefined;
	return { workspace, digest, path };
}

/** One part as a URI writes it, or undefined when the part is empty, `.`, `..`, or holds a control character. */
function segment(part: string): string | undefined {
	return pathParts(`/${part}`) === undefined ? undefined : encodeURIComponent(part);
}

/** Throw a `RangeError` that names `what`, when `value` is undefined. */
function required<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new RangeError(what);
	return value;
}

/**
 * The URI of the commit `commit` of the repository `repository` in the
 * workspace `workspace`. `via` records the branch or the tag that named the
 * commit. A git backend resolves the commit; this function only writes its
 * URI.
 */
export function commitUri(
	workspace: string,
	repository: string,
	commit: string,
	via?: CommitVia,
): string {
	if (!isName(workspace))
		throw new RangeError(
			`Invalid workspace name '${workspace}': names are lowercase, alphanumeric plus dashes.`,
		);
	const [namespace, name, ...rest] = repository.split('/');
	const parts = [namespace, name].map((part) => (part === undefined ? undefined : segment(part)));
	if (rest.length > 0 || parts.includes(undefined))
		throw new RangeError(`A repository ID is <namespace>/<name>: '${repository}'.`);
	if (!COMMIT.test(commit))
		throw new RangeError('A commit is its full hash: 40 or 64 lowercase hex digits.');
	const named = via === undefined ? '' : viaPart(via);
	return `ambion://workspace/${workspace}/repo/${parts.join('/')}${named}/commit/${commit}`;
}

/** The part of a commit URI that records the branch or the tag. */
function viaPart(via: CommitVia): string {
	const [kind, name] = 'branch' in via ? ['branch', via.branch] : ['tag', via.tag];
	return `/${kind}/${required(segment(name), `A ${kind} name must not be empty, '.', or '..': '${name}'.`)}`;
}

/** The decoded parts of a commit URI match, or undefined when a part does not decode. */
function commitParts(
	repository: string,
	kind: string | undefined,
	name: string | undefined,
): { id: string; via?: CommitVia } | undefined {
	const decoded = repository.split('/').map(decodedPart);
	if (decoded.includes(undefined)) return undefined;
	const id = decoded.join('/');
	if (name === undefined) return { id };
	const via = decodedPart(name);
	if (via === undefined) return undefined;
	return { id, via: kind === 'tag' ? { tag: via } : { branch: via } };
}

/**
 * Read a canonical commit URI. Any other string returns undefined. Each
 * part must be in the one form that `commitUri` writes.
 */
export function parseCommitUri(uri: string): CommitUri | undefined {
	const [, workspace, repository, kind, name, commit] = COMMIT_URI.exec(uri) ?? [];
	if (workspace === undefined || repository === undefined || commit === undefined) return undefined;
	const parts = commitParts(repository, kind, name);
	if (parts === undefined) return undefined;
	try {
		if (commitUri(workspace, parts.id, commit, parts.via) !== uri) return undefined;
	} catch {
		return undefined;
	}
	return { workspace, repository: parts.id, commit, ...parts.via };
}
