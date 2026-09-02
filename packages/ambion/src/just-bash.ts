/**
 * The just-bash backends: a virtual Unix filesystem and shell, in-process.
 *
 * One filesystem belongs to the workspace, and each `connect` builds a fresh
 * `Bash` instance over it for one agent, with `cwd` at that agent's home and
 * `HOME` seeded in its environment. Two instances over one filesystem share
 * every file. The home is `/home/<name>`: this backend's convention, imposed
 * on no other backend.
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
import { join } from 'node:path';
import { Bash, type IFileSystem, InMemoryFs, ReadWriteFs } from 'just-bash';
import { BashEnv } from './bash-env.ts';
import type { AgentDefinition, WorkspaceBackend } from './types.ts';

/** Build one agent's environment over the workspace's filesystem. */
async function connectOver(fs: IFileSystem, agent: AgentDefinition): Promise<BashEnv> {
	const home = `/home/${agent.name}`;
	await fs.mkdir(home, { recursive: true });
	return new BashEnv(new Bash({ fs, cwd: home, env: { HOME: home } }), home);
}

/** How much the in-memory default holds, in bytes. A write past it fails with `ENOSPC`. */
export const MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

const inMemory = () => new InMemoryFs(undefined, { maxTotalBytes: MEMORY_LIMIT_BYTES });

/** The default: an in-memory filesystem that lives as long as the handle. */
export function memoryBackend(): WorkspaceBackend {
	let fs: InMemoryFs | undefined = inMemory();
	return {
		connect(agent) {
			if (fs === undefined) fs = inMemory();
			return connectOver(fs, agent);
		},
		async destroy() {
			fs = undefined;
		},
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
