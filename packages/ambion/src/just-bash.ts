/**
 * The just-bash backends: a virtual Unix filesystem and shell, in-process.
 *
 * One filesystem belongs to the workspace, and each `connect` builds a fresh
 * `Bash` instance over it for one agent, with `cwd` at that agent's home and
 * `HOME` seeded in its environment. Two instances over one filesystem share
 * every file. The home is `/home/<name>`: this backend's convention, imposed
 * on no other backend.
 *
 * Every instance runs with `javascript: true` and `python: true`: an agent's
 * `bash` tool can run a script with `js-exec` or `python3`, beside just-bash's
 * coreutils, `jq`, `yq`, `xan` and `sqlite3`. No instance is given a `network`
 * option, so `curl` and every other network command stay absent — the one
 * exception `docs/workspace.md` §1 names, and the boundary this file does not
 * close. `render.ts`'s `WORKSPACE_PARAGRAPH` states this same set to a
 * connected agent, and the two must stay in step.
 *
 * `connect` runs one unconditional `mkdir -p` and checks nothing first. Two
 * calls for one agent can overlap, since Pi runs a turn's tool calls in
 * parallel, and a check-then-create has a window where both create. The
 * idempotent form has none, and a home removed out from under a workspace
 * comes back the next time any tool reaches for it.
 *
 * The boundary is nominal: just-bash is single-user, so nothing stops one
 * agent's `bash` call from reading another's home. What it offers is a wall
 * between an agent's commands and the machine.
 */

import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { Bash, type IFileSystem, InMemoryFs, ReadWriteFs } from 'just-bash';
import { BashEnv } from './bash-env.ts';
import type { AgentDefinition, WorkspaceBackend } from './types.ts';

/** Build one agent's environment over the workspace's filesystem. */
async function connectOver(fs: IFileSystem, agent: AgentDefinition): Promise<BashEnv> {
	const home = `/home/${agent.name}`;
	await fs.mkdir(home, { recursive: true });
	return new BashEnv(
		new Bash({ fs, cwd: home, env: { HOME: home }, javascript: true, python: true }),
		home,
	);
}

/** How much the in-memory default holds, in bytes. A write past it fails with `ENOSPC`. */
export const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

const inMemory = () => new InMemoryFs(undefined, { maxTotalBytes: MEMORY_LIMIT_BYTES });

/** One file, as `readFiles` reads it back out. */
export interface MemoryBackendFile {
	readonly path: string;
	readonly text: string;
}

/**
 * What a `seed` function writes through. Narrow on purpose: `writeFile` is
 * the one thing seeding a filesystem needs, and the interface names none of
 * just-bash's own types, so a caller's seed function commits to nothing about
 * what backs it.
 */
export interface SeedWriter {
	/** Writes `text` at `path`, creating every missing parent directory first. */
	writeFile(path: string, text: string): Promise<void>;
}

export interface MemoryBackendOptions {
	/**
	 * Called once, with a `SeedWriter`, before any agent connects. A seed
	 * function reads and writes one file at a time — from disk, from a
	 * generator, from wherever — rather than handing over an array this
	 * backend would otherwise have to hold in full before it can start.
	 */
	seed?: (write: SeedWriter) => Promise<void>;
}

/**
 * The in-memory backend's own handle: a `WorkspaceBackend`, plus the two
 * things a real directory gives a host for free and an in-memory filesystem
 * does not — seeding it before any agent connects (`seed`, above) and reading
 * it back without one (`readFiles`, below). Assignable to `WorkspaceBackend`
 * wherever that is all a caller needs.
 */
export interface MemoryWorkspaceBackend extends WorkspaceBackend {
	/** Every file currently on the backend's filesystem, path and text, sorted by path. */
	readFiles(): Promise<MemoryBackendFile[]>;
}

/** Every file under `dir`, read as text, recursively. */
async function walk(fs: IFileSystem, dir: string): Promise<MemoryBackendFile[]> {
	const files: MemoryBackendFile[] = [];
	for (const entry of await fs.readdir(dir)) {
		const path = posix.join(dir, entry);
		if ((await fs.lstat(path)).isDirectory) files.push(...(await walk(fs, path)));
		else files.push({ path, text: await fs.readFile(path) });
	}
	return files;
}

/** Every file on `fs`, read as text and sorted by path. */
async function listFiles(fs: IFileSystem): Promise<MemoryBackendFile[]> {
	return (await walk(fs, '/')).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The default: an in-memory filesystem that lives as long as the handle.
 * Building it is async when there is a `seed` to run, so `connect` and
 * `readFiles` both await one lazily-built, memoised filesystem rather than
 * the handle building it up front.
 */
export function memoryBackend(options: MemoryBackendOptions = {}): MemoryWorkspaceBackend {
	let ready: Promise<InMemoryFs> | undefined;
	const build = async (): Promise<InMemoryFs> => {
		const fs = inMemory();
		if (options.seed) {
			await options.seed({
				writeFile: async (path, text) => {
					await fs.mkdir(posix.dirname(path), { recursive: true });
					await fs.writeFile(path, text);
				},
			});
		}
		return fs;
	};
	const filesystem = (): Promise<InMemoryFs> => (ready ??= build());
	return {
		connect: async (agent) => connectOver(await filesystem(), agent),
		async destroy() {
			ready = undefined;
		},
		readFiles: async () => listFiles(await filesystem()),
	};
}

/**
 * A workspace over a real directory. `ReadWriteFs` writes through to disk
 * and needs its root to exist, so the first `connect` creates the root and
 * builds the filesystem; `destroy` removes the root's contents and leaves the
 * root.
 */
export function directoryBackend(root: string): WorkspaceBackend {
	let fs: Promise<ReadWriteFs> | undefined;
	const filesystem = (): Promise<ReadWriteFs> => {
		if (fs === undefined)
			fs = mkdir(root, { recursive: true }).then(() => new ReadWriteFs({ root }));
		return fs;
	};
	return {
		connect: async (agent) => connectOver(await filesystem(), agent),
		async destroy() {
			fs = undefined;
			const entries = await readdir(root).catch(() => []);
			await Promise.all(
				entries.map((entry) => rm(join(root, entry), { recursive: true, force: true })),
			);
		},
	};
}
