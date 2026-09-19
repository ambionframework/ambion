import { BACKGROUND_CONTEXT, type Workspace } from '@ambionframework/workspace';
import { fail } from './rooms.ts';

const browser = { name: 'assistant', identity: 'Workspace browser' };

/** One file in the workspace. */
export interface FileEntry {
	path: string;
	size: number;
}

/** The text of one file. */
export interface FileContent {
	path: string;
	text: string;
	truncated: boolean;
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
			checkFile(info.value);
		}
		const result = await env.readTextFile(path, BACKGROUND_CONTEXT);
		if (!result.ok) fail(result.error.message);
		return { path, text: result.value, truncated: false };
	});
}

function checkFile(info: { kind: string; size: number }): void {
	if (info.kind === 'symlink') fail('The file browser does not follow symbolic links.');
	if (info.kind === 'file' && info.size > 131_072) fail('Preview supports files up to 128 KiB.');
}
