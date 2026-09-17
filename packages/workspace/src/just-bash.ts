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
 * exception the workspace contract names, and the boundary this file does not
 * close. The backend's guidance states this same set to a connected agent.
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
import {
	type AgentHarnessTool,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ExecutionToolContext,
} from '@earendil-works/pi-agent-core';
import { Bash, type IFileSystem, InMemoryFs } from 'just-bash';
import type { WorkspaceBackend } from './backend.ts';
import { BashEnv } from './bash-env.ts';
import type { WorkspaceAgent } from './resource.ts';

/** Build one agent's environment over the workspace's filesystem. */
async function connectOver(fs: IFileSystem, agent: WorkspaceAgent): Promise<BashEnv> {
	const home = `/home/${agent.name}`;
	await fs.mkdir(home, { recursive: true });
	return new BashEnv(
		new Bash({ fs, cwd: home, env: { HOME: home }, javascript: true, python: true }),
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

/** Default tool guidance for the just-bash backends. */
const JUST_BASH_GUIDANCE = [
	`Your workspace gives you four tools: read, write, edit and bash, over a shared virtual`,
	`filesystem. Your home is /home/<your name>. Other agents connected to this workspace`,
	`read and write the same files, with no wall between one agent's home and another's.`,
	``,
	`bash runs a simulated Unix shell: the common coreutils (ls, cat, grep, sed, awk, find,`,
	`tar, and more), plus jq for JSON, yq for YAML and TOML, xan for CSV, and sqlite3. Run`,
	`a script with js-exec (JavaScript) or python3 (Python). bash has no network: curl and`,
	`every other network command are disabled.`,
].join('\n');

/** Create the Pi harness tools offered by each just-bash backend instance. */
function justBashTools(): readonly AgentHarnessTool<ExecutionToolContext>[] {
	return [createReadTool(), createWriteTool(), createEditTool(), createBashTool()];
}

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
 * the handle building it up front. `destroy` can only ever fail to release
 * memory. Destroying the owning workspace clears the cache, releasing the
 * filesystem; the owner prevents any later connection through the handle.
 */
export function memoryBackend(options: MemoryBackendOptions = {}): MemoryWorkspaceBackend {
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
		async destroy() {
			resource.clear(inMemory());
		},
		dispose: async () => resource.clear(inMemory()),
		readFiles: async () => listFiles(await resource.get()),
		tools: justBashTools(),
		guidance: JUST_BASH_GUIDANCE,
	};
}

/**
 * A workspace over a real directory. `ReadWriteFs` writes through to disk
 * and needs its root to exist, so the first `connect` creates the root and
 * builds the filesystem; `destroy` removes the root's contents and leaves the
 * root. Deletion errors are propagated so the owning `Workspace` remains live
 * and retryable; lifecycle state belongs only to that owner.
 *
 * This backend is the one part of this package that needs a real disk, and it
 * loads `ReadWriteFs` on the first connect. A bundler for a runtime without a
 * disk, such as workerd, then keeps the rest of the package: just-bash offers
 * `ReadWriteFs` in its Node build alone, and a static import of it refuses to
 * bundle for every other target.
 */
export function directoryBackend(root: string): WorkspaceBackend {
	const resource = lazyResource(async () => {
		const { ReadWriteFs } = await import('just-bash');
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
		async destroy() {
			let entries: string[];
			try {
				entries = await readdir(root);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					resource.clear();
					return;
				}
				throw error;
			}
			const removals = await Promise.allSettled(
				entries.map((entry) => rm(join(root, entry), { recursive: true, force: true })),
			);
			const failure = removals.find(
				(result): result is PromiseRejectedResult => result.status === 'rejected',
			);
			if (failure) throw failure.reason;
			resource.clear();
		},
		dispose: async () => resource.clear(),
		tools: justBashTools(),
		guidance: JUST_BASH_GUIDANCE,
	};
}
