import { BACKGROUND_CONTEXT, type Workspace } from '@ambionframework/workspace';
import { isDatabase, isDatabasePath, readTables, type TableView, tablesText } from './database.ts';
import { fail } from './rooms.ts';

export type { TableView };

const browser = { name: 'assistant', identity: 'Workspace browser' };

/** One file in the workspace. */
export interface FileEntry {
	path: string;
	size: number;
}

/** One file: its text, or for a SQLite database its tables, with a text copy in `text`. */
export interface FileContent {
	path: string;
	text: string;
	truncated: boolean;
	tables?: TableView[];
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

export async function readFile(workspace: Workspace, path: string): Promise<FileContent> {
	const parts = path.split('/').slice(1);
	if (
		!path.startsWith('/') ||
		parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))
	) {
		fail('Use an absolute workspace file path.');
	}
	return workspace.use(browser, async (env) => {
		let prefix = '';
		for (const part of parts) {
			prefix += `/${part}`;
			const info = await env.fileInfo(prefix, BACKGROUND_CONTEXT);
			if (!info.ok) fail('File not found.');
			checkFile(info.value, isDatabasePath(path));
		}
		if (isDatabasePath(path)) return readDatabase(env, path);
		const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!result.ok) fail(result.error.message);
		return { path, text: result.value, truncated: false };
	});
}

function checkFile(info: { kind: string; size: number }, database: boolean): void {
	if (info.kind === 'symlink') fail('The file browser does not follow symbolic links.');
	if (info.kind !== 'file') return;
	if (database && info.size > MAX_DATABASE) fail('Preview supports databases up to 8 MiB.');
	if (!database && info.size > MAX_TEXT) fail('Preview supports files up to 128 KiB.');
}

const MAX_TEXT = 131_072;
const MAX_DATABASE = 8_388_608;

interface Reader {
	readBinaryFile(
		path: string,
		context: typeof BACKGROUND_CONTEXT,
	): Promise<{ ok: true; value: Uint8Array } | { ok: false; error: { message: string } }>;
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
