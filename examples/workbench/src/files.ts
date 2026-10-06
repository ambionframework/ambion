import { readFile as readLocalFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { CanvasWidget } from '@ambionframework/canvas';
import type { Workspace } from '@ambionframework/workspace';
import {
	isDatabase,
	isDatabasePath,
	readNamedTable,
	readTables,
	type TableView,
	tableNames,
	tablesText,
} from './database.ts';
import { type Pin, plain, shownFiles } from './pins.ts';
import { labUri, tableOfUri } from './refs.ts';
import { fail } from './rooms.ts';

export type { TableView };

/** Where an attached local file lands in the workspace. */
const ATTACHMENTS_DIR = '/attachments';

/** The identity that the files panel reads as. */
export const browser = { name: 'assistant' };

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

export function imageMimeType(path: string): string {
	const extension = Object.keys(IMAGE_TYPES).find((one) => path.toLowerCase().endsWith(one));
	return (extension && IMAGE_TYPES[extension]) ?? 'application/octet-stream';
}

/**
 * One entry of the files panel. `kind` is `table` for a table of the lab
 * database, whose path is the lab URI, and `snapshot` or `commit` for a ref
 * that the panel opens, whose path is the ref. `label` is the short name the
 * list shows in place of a long path.
 */
export interface FileEntry {
	path: string;
	size: number;
	kind?: 'table' | 'snapshot' | 'commit';
	label?: string;
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
			const result = await env.listDir(pending.shift() ?? '/');
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

/** One attached file: where it landed, its size, and the snapshot ref that cites it. */
export interface Attachment extends FileEntry {
	ref: string;
}

/**
 * Copy a local file into the workspace, and snapshot it, so a message cites
 * the bytes the person attached. The name keeps the local file's own name,
 * prefixed with the time it landed, so two attachments of the same name
 * never collide. Checks the size before reading the file, so an oversized
 * file is never buffered into memory.
 */
export async function attachFile(workspace: Workspace, localPath: string): Promise<Attachment> {
	const resolved = localPath.startsWith('~/') ? join(homedir(), localPath.slice(2)) : localPath;
	const size = (await readLocal(() => stat(resolved), localPath)).size;
	if (size > MAX_BYTES.image) fail(`/attach takes files up to ${MAX_BYTES.image / 1_048_576} MiB.`);
	const bytes = await readLocal(() => readLocalFile(resolved), localPath);
	const path = `${ATTACHMENTS_DIR}/${Date.now()}-${basename(resolved)}`;
	await workspace.use(browser, async (env) => {
		await env.createDir(ATTACHMENTS_DIR, { recursive: true });
		const written = await env.writeFile(path, bytes);
		if (!written.ok) fail(written.error.message);
	});
	const [ref] = await workspace.snapshot([path], { agent: browser });
	if (ref === undefined) return fail(`No snapshot of ${path}.`);
	return { path, size: bytes.length, ref };
}

/** Read one file of the workspace as `agent`. The size checks run before the read. */
export async function readFile(
	workspace: Workspace,
	path: string,
	agent: { name: string },
): Promise<FileContent> {
	const parts = path.split('/').slice(1);
	if (
		!path.startsWith('/') ||
		parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
	) {
		fail('Use an absolute workspace file path.');
	}
	const kind = isDatabasePath(path) ? 'database' : isImagePath(path) ? 'image' : 'text';
	return workspace.use(agent, async (env) => {
		await checkAncestors(env, parts, kind);
		if (kind === 'database') return readDatabase(env, path);
		if (kind === 'image') return readImage(env, path);
		const result = await env.readTextFile(path);
		if (!result.ok) fail(result.error.message);
		return { path, text: result.value, truncated: false };
	});
}

/** The most bytes the panel previews, by kind. */
export const MAX_BYTES: Record<'text' | 'database' | 'image', number> = {
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
	): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { message: string } }>;
	fileInfo(
		path: string,
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
		const info = await env.fileInfo(prefix);
		if (!info.ok) fail('File not found.');
		checkFile(info.value, kind);
	}
}

async function readDatabase(env: Reader, path: string): Promise<FileContent> {
	const result = await env.readBinaryFile(path);
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
	const result = await env.readBinaryFile(path);
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

/** The problem of a file that does not fit the kind of its pin, or undefined. */
function mismatch(kind: Pin['kind'], file: FileContent): string | undefined {
	if (kind === 'image') return file.image ? undefined : 'This file is not a picture.';
	if (kind === 'table') return file.tables ? undefined : 'This file is not a SQLite database.';
	return file.image || file.tables ? 'This file is not text.' : undefined;
}

/** The file with terminal escapes dropped from its text and its tables. */
function cleaned(file: FileContent): FileContent {
	const tables = file.tables?.map((table) => ({
		...table,
		name: plain(table.name),
		columns: table.columns.map(plain),
		rows: table.rows.map((row) => row.map(plain)),
	}));
	return { ...file, text: plain(file.text), ...(tables ? { tables } : {}) };
}

/** One pin of a shown file widget, with the file read as its author. A failed read is a problem on the pin. */
async function readPin(workspace: Workspace, widget: CanvasWidget): Promise<Pin> {
	const path = widget.source?.type === 'file' ? widget.source.path : '';
	const pin = {
		name: widget.name,
		title: widget.title === undefined ? undefined : plain(widget.title),
		kind: widget.kind as Pin['kind'],
		author: widget.author,
		path,
	};
	try {
		const file = await readFile(workspace, path, { name: widget.author });
		const problem = mismatch(pin.kind, file);
		return problem ? { ...pin, problem } : { ...pin, file: cleaned(file) };
	} catch (error) {
		return { ...pin, problem: error instanceof Error ? error.message : String(error) };
	}
}

/** The pins of the shown file widgets of a room, in the order of the canvas. */
export function readPins(workspace: Workspace, widgets: readonly CanvasWidget[]): Promise<Pin[]> {
	return Promise.all(shownFiles(widgets).map((widget) => readPin(workspace, widget)));
}
