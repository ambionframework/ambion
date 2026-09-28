import type { Message } from '@ambionframework/ambion';
import { parseCommitUri, parseRoomUri, parseSnapshotUri } from '@ambionframework/ambion';
import { ellipsize } from './text.ts';
import type { Block } from './timeline.ts';
import type { FileContent, FileEntry, Workbench } from './workbench.ts';

/**
 * The refs of a message, as the terminal shows and opens them.
 *
 * A ref is untrusted text from an agent. The room stores it and never reads
 * behind it. The Workbench resolves six forms, each against what the host
 * gives, so no ref reaches a host file:
 *
 * - `ambion://workspace/workbench/snapshot/<digest>/<path>` names the bytes
 *   a file held at a snapshot. The panel shows them, through `readSnapshot`.
 * - `ambion://workspace/workbench/repo/<repository>/.../commit/<hash>` names
 *   a commit of a lab repository. The panel shows it, through `readCommit`.
 * - `file:///<path>` names a file of the workspace as it is now.
 * - `lab:///<table>` names a table of the lab database.
 * - `ambion://room/<room>` names a room. It opens the room.
 * - `ambion://room/<room>/message/<seq>` names a message. It opens its room
 *   and jumps to the message.
 */

/** The name of the Workbench's workspace, the first part of each snapshot ref. */
export const WORKSPACE = 'workbench';

/** The start of a lab table URI. The file browser also uses it as the path of a table. */
const LAB_PREFIX = 'lab:///';

const FILE_PREFIX = /^file:\/\/\/(.*)$/is;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The URI that names one table of the lab database. */
export const labUri = (table: string): string => `${LAB_PREFIX}${table}`;

/** The table that a lab URI names, or undefined for any other string. */
export function tableOfUri(uri: string): string | undefined {
	const name = uri.startsWith(LAB_PREFIX) ? uri.slice(LAB_PREFIX.length) : undefined;
	return name !== undefined && TABLE_NAME.test(name) ? name : undefined;
}

/** What opening a resolved ref does. */
type RefTarget =
	| { kind: 'snapshot'; ref: string; label: string }
	| { kind: 'commit'; ref: string; label: string }
	| { kind: 'file'; path: string }
	| { kind: 'table'; name: string }
	| { kind: 'room'; room: string }
	| { kind: 'message'; room: string; seq: number };

/** What the terminal knows, to check a ref against. */
export interface Known {
	/** The open room. */
	room: string;
	/** The rooms of the host. */
	rooms: readonly string[];
	/** The paths of the workspace files, as the host lists them. */
	files: readonly string[];
	/** The tables of the lab database. */
	tables: readonly string[];
	/** The seqs of the messages read from the open room. */
	seqs: ReadonlySet<number>;
}

type RefKind = 'snapshot' | 'commit' | 'file' | 'table' | 'room' | 'message' | 'unknown';

/** One ref after resolution. `target` is absent when the ref does not resolve. */
export interface ResolvedRef {
	ref: string;
	kind: RefKind;
	/** What the chip shows for the ref. */
	label: string;
	target?: RefTarget;
	/** Why the ref does not resolve. */
	problem?: string;
}

/** One ref of one shown message. `id` names it across redraws. */
export interface RefItem {
	id: string;
	seq: number;
	resolved: ResolvedRef;
}

const unresolved = (ref: string, kind: RefKind, problem: string): ResolvedRef => ({
	ref,
	kind,
	label: ref,
	problem,
});

/**
 * The workspace path a `file:` ref names, or a reason it names none. The path
 * must be absolute and must hold no empty part, no `.` or `..`, no backslash,
 * and no NUL after decoding. A query or a fragment is dropped.
 */
function filePath(ref: string): { path: string } | { problem: string } {
	const match = FILE_PREFIX.exec(ref);
	if (!match) return { problem: 'use file:///<workspace path>' };
	let decoded: string;
	try {
		decoded = decodeURIComponent((match[1] ?? '').split(/[?#]/)[0] ?? '');
	} catch {
		return { problem: 'the path is not valid' };
	}
	const bad = decoded
		.split('/')
		.some((part) => part === '' || part === '.' || part === '..' || /[\\\0]/.test(part));
	if (bad) return { problem: 'the path is not a workspace path' };
	return { path: `/${decoded}` };
}

function resolveFile(ref: string, known: Known): ResolvedRef {
	const named = filePath(ref);
	if ('problem' in named) return unresolved(ref, 'file', named.problem);
	if (!known.files.includes(named.path)) return unresolved(ref, 'file', 'not in the workspace');
	return { ref, kind: 'file', label: named.path, target: { kind: 'file', path: named.path } };
}

function resolveTable(ref: string, known: Known): ResolvedRef {
	const name = tableOfUri(ref);
	if (name === undefined) return unresolved(ref, 'table', 'use lab:///<table>');
	if (!known.tables.includes(name)) return unresolved(ref, 'table', 'no such lab table');
	return { ref, kind: 'table', label: name, target: { kind: 'table', name } };
}

/**
 * A snapshot of this workspace opens from the object store. The label is the
 * path the file had, and the first digits of the digest tell two snapshots
 * apart. The panel says so when the store holds no bytes for the ref.
 */
function resolveSnapshot(ref: string): ResolvedRef | undefined {
	const uri = parseSnapshotUri(ref);
	if (uri === undefined) return undefined;
	const label = `${uri.path} @${uri.digest.slice(0, 8)}`;
	if (uri.workspace !== WORKSPACE)
		return { ...unresolved(ref, 'snapshot', `in workspace ${uri.workspace}`), label };
	return { ref, kind: 'snapshot', label, target: { kind: 'snapshot', ref, label } };
}

/**
 * A commit of this workspace opens in the panel. The label shows its
 * repository, the branch or the tag, and the short hash.
 */
function resolveCommit(ref: string): ResolvedRef | undefined {
	const uri = parseCommitUri(ref);
	if (uri === undefined) return undefined;
	const via = uri.branch ?? uri.tag;
	const label = [uri.repository, via, uri.commit.slice(0, 7)].filter(Boolean).join(' ');
	if (uri.workspace !== WORKSPACE)
		return { ...unresolved(ref, 'commit', `in workspace ${uri.workspace}`), label };
	return { ref, kind: 'commit', label, target: { kind: 'commit', ref, label } };
}

/**
 * A room ref opens its room, and a message ref opens its room and jumps to
 * the message. A message of the open room resolves only once it is read.
 */
function resolveRoom(ref: string, known: Known): ResolvedRef {
	const uri = parseRoomUri(ref);
	if (uri === undefined) return unresolved(ref, 'unknown', 'this form opens nothing');
	const kind = uri.message === undefined ? 'room' : 'message';
	if (!known.rooms.includes(uri.room)) return unresolved(ref, kind, `no room ${uri.room}`);
	if (uri.message === undefined)
		return { ref, kind, label: uri.room, target: { kind: 'room', room: uri.room } };
	if (uri.room === known.room && !known.seqs.has(uri.message))
		return unresolved(ref, kind, `message ${uri.message} is not read yet`);
	const label = uri.room === known.room ? `${uri.message}` : `${uri.room} ${uri.message}`;
	return { ref, kind, label, target: { kind: 'message', room: uri.room, seq: uri.message } };
}

/** Resolve one ref. A ref of another scheme is `unknown` and opens nothing. */
export function resolveRef(ref: string, known: Known): ResolvedRef {
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(ref)?.[1]?.toLowerCase();
	if (scheme === 'file') return resolveFile(ref, known);
	if (scheme === 'lab') return resolveTable(ref, known);
	if (scheme === 'ambion')
		return resolveSnapshot(ref) ?? resolveCommit(ref) ?? resolveRoom(ref, known);
	return unresolved(ref, 'unknown', 'this scheme opens nothing');
}

/**
 * One line for one ref, fitted to `width` cells. The marker and the kind stay
 * whole, and the ref text takes the ellipsis. A ref that does not resolve
 * ends with the reason.
 */
export function chipLine(item: ResolvedRef, width: number): string {
	const kind = item.kind === 'unknown' ? 'ref' : item.kind;
	const head = `${item.target ? '↗' : '✗'} ${kind}  `;
	const tail = item.problem ? `  (${item.problem})` : '';
	const room = Math.max(4, width - head.length - tail.length);
	return `${head}${ellipsize(item.label, room)}${tail}`;
}

/** The messages that the blocks show: the open ones, and the ones inside an open discussion. */
function shownMessages(blocks: readonly Block[]): Message[] {
	return blocks.flatMap((block) => {
		if (block.type === 'message') return [block.message];
		if (block.type === 'discussion' && block.expanded)
			return block.items.map((item) => item.message);
		return [];
	});
}

/** The refs of the shown messages, top to bottom and in the order each message lists them. */
export function refItems(blocks: readonly Block[], known: Known): RefItem[] {
	return shownMessages(blocks).flatMap((message) =>
		(message.kind === 'said' || message.kind === 'summary' ? (message.refs ?? []) : []).map(
			(ref, index) => ({
				id: `${message.seq}#${index}`,
				seq: message.seq,
				resolved: resolveRef(ref, known),
			}),
		),
	);
}

/** The key of the discussion that holds the message at `seq`, when a discussion does. */
export function holderOf(blocks: readonly Block[], seq: number): string | undefined {
	for (const block of blocks)
		if (block.type === 'discussion' && block.items.some((item) => item.message.seq === seq))
			return block.key;
	return undefined;
}

/** True when the blocks show the message at `seq`: open, or in a discussion that is open. */
export function shows(blocks: readonly Block[], seq: number): boolean {
	return shownMessages(blocks).some((message) => message.seq === seq);
}

/** The entries of the files panel: the workspace files, then the tables of the lab database. */
export function panelEntries(files: readonly FileEntry[], tables: readonly string[]): FileEntry[] {
	return [
		...files,
		...tables.map((name) => ({ path: labUri(name), size: 0, kind: 'table' as const })),
	];
}

/**
 * The files panel entry a target opens, or undefined for a target that opens
 * a room. A snapshot and a commit are not in the list of files, so the panel
 * lists them first.
 */
export function panelOf(target: RefTarget): { path: string; extra?: FileEntry } | undefined {
	if (target.kind === 'snapshot' || target.kind === 'commit') {
		const { ref: path, kind, label } = target;
		return { path, extra: { path, size: 0, kind, label } };
	}
	if (target.kind === 'file') return { path: target.path };
	return target.kind === 'table' ? { path: labUri(target.name) } : undefined;
}

/** Load one entry of the files panel: a snapshot, a commit, a lab table, or a workspace file. */
export function loadEntry(host: Workbench, path: string): Promise<FileContent> {
	if (parseSnapshotUri(path) !== undefined) return host.snapshot(path);
	if (parseCommitUri(path) !== undefined) return host.commit(path);
	return tableOfUri(path) === undefined ? host.file(path) : host.labTable(path);
}

/** Why a message ref shows nothing: a summary stands for the message, or the room has no such message. */
export function unshownText(seq: number, room: string, read: readonly { seq: number }[]): string {
	return read.some((message) => message.seq === seq)
		? `Message ${seq} is not in the conversation. A summary stands for it.`
		: `Room ${room} has no message ${seq} yet.`;
}
