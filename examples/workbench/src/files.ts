import { readFile as readLocalFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { BACKGROUND_CONTEXT, type Workspace } from '@ambionframework/workspace';
import {
	isDatabase,
	isDatabasePath,
	readNamedTable,
	readTables,
	type TableView,
	tableNames,
	tablesText,
} from './database.ts';
import { labUri, tableOfUri } from './refs.ts';
import { fail } from './rooms.ts';

export type { TableView };

/** Where an attached local file lands in the workspace. */
const ATTACHMENTS_DIR = '/attachments';

const browser = { name: 'assistant' };

/** The extensions the panel previews as a picture, and the type each names. */
const IMAGE_TYPES: Record<string, string> = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
};

export const isImagePath = (path: string): boolean =>
	Object.keys(IMAGE_TYPES).some((extension) => path.toLowerCase().endsWith(extension));

function imageMimeType(path: string): string {
	const extension = Object.keys(IMAGE_TYPES).find((one) => path.toLowerCase().endsWith(one));
	return (extension && IMAGE_TYPES[extension]) ?? 'application/octet-stream';
}

/** One file. `kind` is `table` for a table of the lab database, and its path is the lab URI. */
export interface FileEntry {
	path: string;
	size: number;
	kind?: 'table';
}

/** One picture, as the panel renders it: its bytes and the type they decode as. */
export interface ImageContent {
	data: Uint8Array;
	mimeType: string;
}

/** One file: its text, or for a SQLite database its tables, with a text copy in `text`. */
export interface FileContent {
	path: string;
	text: string;
	truncated: boolean;
	tables?: TableView[];
	/** Set instead of `text` for a file the panel previews as a picture. */
	image?: ImageContent;
}

export async function listFiles(workspace: Workspace): Promise<FileEntry[]> {
	return workspace.use(browser, async (env) => {
		const files: FileEntry[] = [];
		const pending = ['/'];
		let visited = 0;
		while (pending.length > 0 && visited < 500) {
			const result = await env.listDir(pending.shift() ?? '/', BACKGROUND_CONTEXT);
			if (!result.ok) throw result.error;
			const entries = result.value.slice(0, 500 - visited);
			visited += entries.length;
			files.push(
				...entries
					.filter((entry) => entry.kind === 'file')
					.map(({ path, size }) => ({ path, size })),
			);
			pending.push(
				...entries
					// Virtual shell devices are infrastructure, not project artifacts.
					.filter((entry) => entry.kind === 'directory' && entry.path !== '/dev')
					.map((entry) => entry.path),
			);
		}
		return files.sort((a, b) => a.path.localeCompare(b.path));
	});
}

/** The result of a local read, or the read error named after the path the person typed. */
async function readLocal<T>(operation: () => Promise<T>, localPath: string): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		return fail(
			`Cannot read ${localPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Copy a local file into the workspace, so a `file:///` ref can cite it. The
 * name keeps the local file's own name, prefixed with the time it landed, so
 * two attachments of the same name never collide. Checks the size before
 * reading the file, so an oversized file is never buffered into memory.
 */
export async function attachFile(workspace: Workspace, localPath: string): Promise<FileEntry> {
	const resolved = localPath.startsWith('~/') ? join(homedir(), localPath.slice(2)) : localPath;
	const size = (await readLocal(() => stat(resolved), localPath)).size;
	if (size > MAX_BYTES.image) fail(`/attach takes files up to ${MAX_BYTES.image / 1_048_576} MiB.`);
	const bytes = await readLocal(() => readLocalFile(resolved), localPath);
	const path = `${ATTACHMENTS_DIR}/${Date.now()}-${basename(resolved)}`;
	await workspace.use(browser, async (env) => {
		await env.createDir(ATTACHMENTS_DIR, { recursive: true }, BACKGROUND_CONTEXT);
		const written = await env.writeFile(path, bytes, BACKGROUND_CONTEXT);
		if (!written.ok) fail(written.error.message);
	});
	return { path, size: bytes.length };
}

export async function readFile(workspace: Workspace, path: string): Promise<FileContent> {
	const parts = path.split('/').slice(1);
	if (
		!path.startsWith('/') ||
		parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
	) {
		fail('Use an absolute workspace file path.');
	}
	const kind = isDatabasePath(path) ? 'database' : isImagePath(path) ? 'image' : 'text';
	return workspace.use(browser, async (env) => {
		await checkAncestors(env, parts, kind);
		if (kind === 'database') return readDatabase(env, path);
		if (kind === 'image') return readImage(env, path);
		const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!result.ok) fail(result.error.message);
		return { path, text: result.value, truncated: false };
	});
}

const MAX_BYTES: Record<'text' | 'database' | 'image', number> = {
	text: 131_072,
	database: 8_388_608,
	image: 8_388_608,
};
const SIZE_ADVICE: Record<'text' | 'database' | 'image', string> = {
	text: 'Preview supports files up to 128 KiB.',
	database: 'Preview supports databases up to 8 MiB.',
	image: 'Preview supports pictures up to 8 MiB.',
};

function checkFile(
	info: { kind: string; size: number },
	kind: 'text' | 'database' | 'image',
): void {
	if (info.kind === 'symlink') fail('The file browser does not follow symbolic links.');
	if (info.kind !== 'file') return;
	if (info.size > MAX_BYTES[kind]) fail(SIZE_ADVICE[kind]);
}

interface Reader {
	readBinaryFile(
		path: string,
		context: typeof BACKGROUND_CONTEXT,
	): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { message: string } }>;
	fileInfo(
		path: string,
		context: typeof BACKGROUND_CONTEXT,
	): Promise<
		{ ok: true; value: { kind: string; size: number } } | { ok: false; error: { message: string } }
	>;
}

/** Every ancestor of a path must be a plain, sized, non-symlink directory or file. */
async function checkAncestors(
	env: Reader,
	parts: readonly string[],
	kind: 'text' | 'database' | 'image',
): Promise<void> {
	let prefix = '';
	for (const part of parts) {
		prefix += `/${part}`;
		const info = await env.fileInfo(prefix, BACKGROUND_CONTEXT);
		if (!info.ok) fail('File not found.');
		checkFile(info.value, kind);
	}
}

async function readDatabase(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
	if (!result.ok) return fail(result.error.message);
	if (!isDatabase(result.value)) return fail('This file is not a SQLite database.');
	try {
		const tables = await readTables(result.value);
		return { path, text: tablesText(tables), truncated: false, tables };
	} catch (error) {
		return fail(
			`Cannot read this database: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

async function readImage(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path, BACKGROUND_CONTEXT);
	if (!result.ok) return fail(result.error.message);
	return {
		path,
		text: '',
		truncated: false,
		image: { data: result.value, mimeType: imageMimeType(path) },
	};
}

/** The tables of the lab database, or none when the database does not exist yet. */
export function listLabTables(location: string): string[] {
	try {
		return tableNames(location);
	} catch {
		return [];
	}
}

/** One table of the lab database, as a preview. `path` is the lab URI of the table. */
export function readLabTable(location: string, uri: string): FileContent {
	const name = tableOfUri(uri);
	if (name === undefined) return fail('Use lab:///<table>.');
	let table: TableView | undefined;
	try {
		table = readNamedTable(location, name);
	} catch (error) {
		return fail(
			`Cannot read the lab database: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!table) return fail('No such lab table.');
	return { path: labUri(name), text: tablesText([table]), truncated: false, tables: [table] };
}
