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
 * coreutils, `jq`, `yq`, `xan` and `sqlite3`. Each instance also has `git`
 * from just-git, with the agent's name as the locked author. No instance is
 * given a `network` option, so `curl` and every other network command stay
 * absent. `git` runs with `network: false`, so it stays inside the same
 * boundary. That absence is the one exception the workspace contract names,
 * and the boundary this file does not close. The backend's guidance states
 * this same set to a connected agent.
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

import { mkdir } from 'node:fs/promises';
import { posix } from 'node:path';
import {
	type BashBackend,
	DEFAULT_AUDIT_LOG,
	type WorkspaceLayout,
} from '@ambionframework/workspace';
import type { WorkspaceAgent } from '@ambionframework/workspace/resource';
import { Bash, type IFileSystem, InMemoryFs, ReadWriteFs } from 'just-bash';
import { createGit } from 'just-git';
import { BashEnv } from './bash-env.ts';
import { DEV_DIR, withDevices } from './devices.ts';

/**
 * Where the just-bash backends keep the audit log and the room mirrors.
 * Both backends name the same layout, so no file moves.
 */
const JUST_BASH_LAYOUT: WorkspaceLayout = {
	audit: DEFAULT_AUDIT_LOG,
	rooms: '/rooms',
};

/**
 * The `git` command of one agent. The identity is locked to the agent's
 * name, so every commit names the seat that made it. `network: false` keeps
 * git inside the same boundary as the shell: a remote is a path on the
 * workspace's filesystem.
 */
function gitFor(agent: WorkspaceAgent) {
	return createGit({
		identity: { name: agent.name, email: `${agent.name}@ambion.invalid`, locked: true },
		network: false,
	});
}

/** Build one agent's environment over the workspace's filesystem. */
async function connectOver(fs: IFileSystem, agent: WorkspaceAgent): Promise<BashEnv> {
	const home = `/home/${agent.name}`;
	await fs.mkdir(home, { recursive: true });
	return new BashEnv(
		new Bash({
			fs: withDevices(fs),
			cwd: home,
			env: { HOME: home },
			javascript: true,
			python: true,
			customCommands: [gitFor(agent)],
		}),
		home,
	);
}

/** How much the in-memory backend holds, in bytes. A write past it fails with `ENOSPC`. */
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
 * The in-memory backend's own handle: a `BashBackend`, plus the two
 * things a real directory gives a host for free and an in-memory filesystem
 * does not — seeding it before any agent connects (`seed`, above) and reading
 * it back without one (`readFiles`, below). Assignable to `BashBackend`
 * wherever that is all a caller needs.
 */
export interface MemoryBashBackend extends BashBackend {
	/** Every file currently on the backend's filesystem, path and text, sorted by path. */
	readFiles(): Promise<MemoryBackendFile[]>;
}

/** Shell guidance for the just-bash backends: their commands, network, and isolation. */
const JUST_BASH_GUIDANCE = [
	`The shell is a simulated Unix shell: the common coreutils (ls, cat, grep, sed, awk, find,`,
	`tar, and more), plus jq for JSON, yq for YAML and TOML, xan for CSV, and sqlite3. Run a`,
	`script with js-exec (JavaScript) or python3 (Python).`,
	``,
	`git is available: init, clone, add, commit, status, log, diff, show, branch, checkout,`,
	`switch, merge, rebase, cherry-pick, stash, tag, reset, fetch, pull, push, and more. Each`,
	`command supports a subset of the flags of real git. Your commits carry your name as the`,
	`author, and git config does not change it. A remote is a path in this filesystem, such as`,
	`/home/<other agent>/<repo>; git has no network access.`,
	``,
	`The shell has no network: curl and every other network command are disabled. Your home is`,
	`/home/<your name>, and there is no wall between one agent's home and another's.`,
].join('\n');

/**
 * Every plain file under `dir`, read as text, recursively. A symlink is
 * neither a directory nor a plain file, and is skipped rather than followed:
 * following one risks reading the same content twice under two paths, or
 * looping forever on a cycle.
 */
async function walk(fs: IFileSystem, dir: string): Promise<MemoryBackendFile[]> {
	const files: MemoryBackendFile[] = [];
	for (const entry of await fs.readdir(dir)) {
		const path = posix.join(dir, entry);
		if (path === DEV_DIR) continue;
		const stat = await fs.lstat(path);
		if (stat.isDirectory) files.push(...(await walk(fs, path)));
		else if (!stat.isSymbolicLink) files.push({ path, text: await fs.readFile(path) });
	}
	return files;
}

/** Every plain file on `fs`, read as text and sorted by path. */
async function listFiles(fs: IFileSystem): Promise<MemoryBackendFile[]> {
	return (await walk(fs, '/')).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Memoises what `build` returns and retries after a rejection instead of
 * staying poisoned by it. The workspace owner, rather than this cache, owns
 * lifecycle and prevents use after destruction.
 */
function lazyResource<T>(build: () => Promise<T>): {
	get(): Promise<T>;
	clear(replacement?: T): void;
} {
	let ready: Promise<T> | undefined;
	return {
		get: () => {
			if (ready === undefined) {
				ready = build().catch((error) => {
					ready = undefined; // let the next call retry rather than staying poisoned
					throw error;
				});
			}
			return ready;
		},
		clear: (replacement) => {
			ready = replacement === undefined ? undefined : Promise.resolve(replacement);
		},
	};
}

/**
 * An in-memory filesystem that lives as long as the backend resource.
 * Building it is async when there is a `seed` to run, so `connect` and
 * `readFiles` both await one lazily-built, memoised filesystem rather than
 * the handle building it up front. Disposing the owning workspace clears
 * the cache, releasing the filesystem; the owner prevents any later
 * connection through the handle. A host deletes the data it owns.
 */
export function memoryBackend(options: MemoryBackendOptions = {}): MemoryBashBackend {
	const resource = lazyResource(async () => {
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
	});
	return {
		connect: async (agent) => connectOver(await resource.get(), agent),
		dispose: async () => resource.clear(inMemory()),
		readFiles: async () => listFiles(await resource.get()),
		guidance: JUST_BASH_GUIDANCE,
		layout: JUST_BASH_LAYOUT,
	};
}

/**
 * A workspace over a real directory. `ReadWriteFs` writes through to disk
 * and needs its root to exist, so the first `connect` creates the root and
 * builds the filesystem. Disposal releases the filesystem handle and keeps
 * the root and its files. A host deletes the data it owns.
 *
 * This backend is the one part of this package that needs a real disk.
 */
export function directoryBackend(root: string): BashBackend {
	const resource = lazyResource(async () => {
		await mkdir(root, { recursive: true });
		class DirectoryFs extends ReadWriteFs {
			override async lstat(path: string) {
				// ReadWriteFs 3.4.2 validates the parent of / outside its own root.
				// The virtual root is a directory, never a traversable symlink;
				// stat keeps the backend's root validation without inspecting its parent.
				return posix.normalize(path) === '/' ? this.stat('/') : super.lstat(path);
			}
		}
		return new DirectoryFs({ root });
	});
	return {
		connect: async (agent) => connectOver(await resource.get(), agent),
		dispose: async () => resource.clear(),
		guidance: JUST_BASH_GUIDANCE,
		layout: JUST_BASH_LAYOUT,
	};
}
