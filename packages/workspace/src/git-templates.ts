/**
 * Templates: the sources a host registers, and the pure helpers that
 * compare them with a repository.
 *
 * A git backend registers each template before its first operation. It
 * compares the files of the source with the tree at the tip of the
 * template by their blob hashes, so it writes nothing to compare. This
 * module reads no repository and loads no git library. Each git backend
 * reads the hashes at a tip with its own library.
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** The files of a template: each path, relative to the root, with its bytes. */
export type TemplateFiles = Readonly<Record<string, Uint8Array>>;

/** Where the files of a template come from. */
export interface TemplateSource {
	read(): Promise<TemplateFiles>;
}

/** One template: its source, and an optional description that `repos` shows. */
export interface TemplateRegistration {
	readonly source: TemplateSource | Readonly<Record<string, string>>;
	readonly description?: string;
}

/**
 * Read every file under `path` on the host, as bytes. It skips `.git` and
 * every symbolic link.
 */
export function fromDirectory(path: string): TemplateSource {
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

/** The files of a registration, as bytes. */
export async function filesOf(registration: TemplateRegistration): Promise<TemplateFiles> {
	const { source } = registration;
	if (typeof source.read === 'function') return (source as TemplateSource).read();
	const encoder = new TextEncoder();
	return Object.fromEntries(
		Object.entries(source as Readonly<Record<string, string>>).map(([path, text]) => [
			path,
			encoder.encode(text),
		]),
	);
}

/** The git blob hash of `bytes`. */
function blobHash(bytes: Uint8Array): string {
	return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** Each path of `files` with its blob hash. */
export function hashesOf(files: TemplateFiles): ReadonlyMap<string, string> {
	return new Map(Object.entries(files).map(([path, bytes]) => [path, blobHash(bytes)]));
}

/** Whether two maps of path to blob hash hold the same files. */
export function sameFiles(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [path, hash] of a) if (b.get(path) !== hash) return false;
	return true;
}

/** The change that turns the tip into `files`: every file, and `null` for a file that went. */
export function changeTo(
	files: TemplateFiles,
	tip: ReadonlyMap<string, string>,
): Record<string, Uint8Array | null> {
	const change: Record<string, Uint8Array | null> = { ...files };
	for (const path of tip.keys()) if (!(path in files)) change[path] = null;
	return change;
}
