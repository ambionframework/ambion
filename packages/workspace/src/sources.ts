/**
 * Files that a host gives the workspace: where they come from, and how two
 * sets of them compare.
 *
 * A git template and a skill set both start from a source. `fromDirectory`
 * reads a directory on the host, and an inline record gives the text of
 * each file. The blob hash of each file compares two sets with no write.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** A set of files: each path, relative to the root, with its bytes. */
export type SourceFiles = Readonly<Record<string, Uint8Array>>;

/** Where a set of files comes from. */
export interface FileSource {
	read(): Promise<SourceFiles>;
}

/** A source, or the text of each file by its path. */
export type SourceInput = FileSource | Readonly<Record<string, string>>;

/**
 * Read every file under `path` on the host, as bytes. It skips `.git` and
 * every symbolic link.
 */
export function fromDirectory(path: string): FileSource {
	return { read: async () => Object.fromEntries(await walk(path, path)) };
}

async function walk(root: string, dir: string): Promise<[string, Uint8Array][]> {
	const found: [string, Uint8Array][] = [];
	for (const name of (await readdir(dir)).sort()) {
		if (name === '.git') continue;
		const path = join(dir, name);
		const stat = await lstat(path);
		if (stat.isDirectory()) found.push(...(await walk(root, path)));
		else if (stat.isFile())
			found.push([relative(root, path).split(sep).join('/'), await readFile(path)]);
	}
	return found;
}

/** The files of `source`, as bytes. */
export async function readSource(source: SourceInput): Promise<SourceFiles> {
	if (typeof source.read === 'function') return (source as FileSource).read();
	const encoder = new TextEncoder();
	return Object.fromEntries(
		Object.entries(source as Readonly<Record<string, string>>).map(([path, text]) => [
			path,
			encoder.encode(text),
		]),
	);
}

/** The git blob hash of `bytes`. */
export function blobHash(bytes: Uint8Array): string {
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Each path of `files` with its blob hash. */
export function hashesOf(files: SourceFiles): ReadonlyMap<string, string> {
	return new Map(Object.entries(files).map(([path, bytes]) => [path, blobHash(bytes)]));
}

/** Whether two maps of path to blob hash hold the same files. */
export function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [path, hash] of a) if (b.get(path) !== hash) return false;
	return true;
}
