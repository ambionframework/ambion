/**
 * The files panel's preview of a snapshot ref and of a commit ref. Each reads
 * through the workspace, so the workspace checks what the ref names: the
 * digest of a snapshot, and the commit on the git server.
 */

import { type CommitUri, parseCommitUri, parseSnapshotUri } from '@ambionframework/ambion';
import type { GitCommit, Workspace } from '@ambionframework/workspace';
import { validRefName } from '@ambionframework/workspace/git';
import { isDatabase, readTables, tablesText } from './database.ts';
import { type FileContent, imageMimeType, isImagePath, MAX_BYTES } from './files.ts';

/** How many leading bytes the panel reads to tell text from binary, as git does. */
const SNIFF_BYTES = 8000;

/** True when the first bytes hold a NUL: git reads such a file as binary. */
const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, SNIFF_BYTES).includes(0);

/** A note when the panel shows no database or picture this large, or `undefined`. */
function tooLarge(bytes: Uint8Array, named: string): string | undefined {
	const kind = isDatabase(bytes) ? 'database' : isImagePath(named) ? 'picture' : undefined;
	if (kind === undefined) return undefined;
	const limit = kind === 'database' ? MAX_BYTES.database : MAX_BYTES.image;
	if (bytes.byteLength <= limit) return undefined;
	return `A ${kind} of ${bytes.byteLength} bytes. The preview shows one of up to ${limit / 1_048_576} MiB. An agent reads it with fetch.`;
}

/**
 * The bytes of a snapshot ref, from the object store, as the panel shows
 * them: the tables of a SQLite database, a picture when the path it had
 * names one, a note for other binary bytes, and text otherwise.
 */
export async function readSnapshotFile(workspace: Workspace, ref: string): Promise<FileContent> {
	const bytes = await workspace.readSnapshot(ref);
	const named = parseSnapshotUri(ref)?.path ?? ref;
	const large = tooLarge(bytes, named);
	if (large) return { path: ref, text: large, truncated: false };
	if (isDatabase(bytes)) {
		const tables = await readTables(bytes);
		return { path: ref, text: tablesText(tables), truncated: false, tables };
	}
	if (isImagePath(named)) {
		const image = { data: bytes, mimeType: imageMimeType(named) };
		return { path: ref, text: '', truncated: false, image };
	}
	if (isBinary(bytes)) {
		const text = `A binary file of ${bytes.byteLength} bytes. An agent reads it with fetch.`;
		return { path: ref, text, truncated: false };
	}
	const text = new TextDecoder().decode(bytes.subarray(0, MAX_BYTES.text));
	return { path: ref, text, truncated: bytes.byteLength > MAX_BYTES.text };
}

/** How the panel names a change: the letter `git diff-tree --name-status` prints. */
const LETTER = { added: 'A', modified: 'M', deleted: 'D' } as const;

/** The lines of one commit, in the order `git show --stat` gives them. */
function commitLines(named: CommitUri, commit: GitCommit): string[] {
	const via =
		named.branch === undefined ? named.tag && `tag ${named.tag}` : `branch ${named.branch}`;
	const parents = commit.parents.length === 0 ? 'none: a root commit' : commit.parents.join(', ');
	return [
		via === undefined ? named.repository : `${named.repository}, ${via}`,
		`commit ${commit.hash}`,
		`Author: ${commit.author.name} <${commit.author.email}>`,
		`Date:   ${commit.author.date}`,
		`Parent: ${parents}`,
		'',
		...commit.message
			.trimEnd()
			.split('\n')
			.map((line) => `    ${line}`),
		'',
		`Changes (${commit.changes.length}):`,
		...commit.changes.map((entry) => `  ${LETTER[entry.change]} ${entry.path}`),
	];
}

/**
 * Where the branch or the tag of a commit ref points now: at the commit, at
 * another commit, or at nothing. A ref with neither gives nothing.
 */
async function nowLine(workspace: Workspace, named: CommitUri): Promise<string | undefined> {
	const name = named.branch ?? named.tag;
	const owner = workspace.git;
	if (name === undefined || owner === undefined) return undefined;
	const at = named.branch === undefined ? { tag: name } : { branch: name };
	const label = `The ${named.branch === undefined ? 'tag' : 'branch'} ${name}`;
	// An agent writes the ref, so its name can be one git refuses. The commit still shows.
	if (!validRefName(name)) return `${label} is not a name git accepts; the ref keeps this commit.`;
	// Only a missing name reads as gone. Any other failure is the preview's error.
	const now = await owner.use(workspace.host, (env) => env.resolve(named.repository, at));
	if (now === undefined) return `${label} no longer exists; the ref keeps this commit.`;
	return now === named.commit
		? `${label} still names this commit.`
		: `${label} now names ${now.slice(0, 7)}; the ref keeps this commit.`;
}

/**
 * The commit a commit ref names, as the panel shows it: the repository and
 * the name the ref records, the hash, the author, the parents, the message,
 * the changed paths, and where the branch or the tag points now.
 */
export async function readCommitFile(workspace: Workspace, ref: string): Promise<FileContent> {
	const named = parseCommitUri(ref);
	if (named === undefined) throw new Error(`${ref} is not a commit ref.`);
	const commit = await workspace.readCommit(ref);
	const now = await nowLine(workspace, named);
	const lines = [...commitLines(named, commit), ...(now === undefined ? [] : ['', now])];
	return { path: ref, text: lines.join('\n'), truncated: false };
}
