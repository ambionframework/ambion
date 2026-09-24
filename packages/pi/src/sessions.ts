/**
 * Where a seat keeps its Pi harness sessions.
 *
 * A session holds the transcript of one exchange for one seat. The executor
 * creates it under the id of the activation that began it, and reopens it
 * by that id when the room names it in `spec.resume`. A session that the
 * store does not hold, or cannot read, opens as nothing, and the activation
 * begins a fresh one.
 *
 * - **Memory.** `memorySessions()` keeps each session in a Pi
 *   `MemorySessionRepo`. The sessions live as long as the store.
 * - **Disk.** `diskSessions(dir)` keeps each session as a JSONL file under
 *   `dir`, in a folder for each room and seat. A restart on the same disk
 *   reopens it. The store loads the Node file system on first use, so the
 *   entry of this package loads on a host with no disk.
 */
import type {
	Context,
	JsonlSessionMetadata,
	Session,
	SessionMetadata,
} from '@earendil-works/pi-agent-core';
import { JsonlSessionRepo, MemorySessionRepo } from '@earendil-works/pi-agent-core';

/** The seat a session belongs to. */
export interface SessionScope {
	readonly room: string;
	readonly seat: string;
}

/** A seat's store of Pi harness sessions. */
export interface PiSessions {
	/**
	 * Create a session under `id`. When the store already holds that id, the
	 * harness gives the session a fresh id.
	 */
	create(scope: SessionScope, id: string, context: Context): Promise<Session>;
	/** Open the session `id`. Nothing, when the store does not hold it or cannot read it. */
	open(scope: SessionScope, id: string, context: Context): Promise<Session | undefined>;
}

/** Create under `id`, or under a fresh id when the store refuses `id`. */
async function createWithFallback(
	create: (id: string | undefined) => Promise<Session>,
	id: string,
): Promise<Session> {
	try {
		return await create(id);
	} catch {
		return create(undefined);
	}
}

/** Open the listed session with the id `id`, or nothing when it is absent or unreadable. */
async function openListed<T extends SessionMetadata>(
	listed: () => Promise<readonly T[]>,
	open: (metadata: T) => Promise<Session>,
	id: string,
): Promise<Session | undefined> {
	try {
		const metadata = (await listed()).find((candidate) => candidate.id === id);
		return metadata === undefined ? undefined : await open(metadata);
	} catch {
		return undefined;
	}
}

/** Sessions in memory, one Pi repository for each room and seat. */
export function memorySessions(): PiSessions {
	const repos = new Map<string, MemorySessionRepo>();
	const repoOf = (scope: SessionScope): MemorySessionRepo => {
		const key = `${scope.room}\u0000${scope.seat}`;
		let repo = repos.get(key);
		if (repo === undefined) {
			repo = new MemorySessionRepo();
			repos.set(key, repo);
		}
		return repo;
	};
	return {
		create: (scope, id, context) =>
			createWithFallback(
				(wanted) => repoOf(scope).create(wanted === undefined ? {} : { id: wanted }, context),
				id,
			),
		open: (scope, id, context) => {
			const repo = repoOf(scope);
			return openListed(
				() => repo.list(undefined, context),
				(metadata) => repo.open(metadata, context),
				id,
			);
		},
	};
}

/** The directory for sessions when the host names none: `ambion-pi-sessions` in the OS temporary directory. */
export async function defaultSessionDir(): Promise<string> {
	const [{ tmpdir }, { join }] = await Promise.all([import('node:os'), import('node:path')]);
	return join(tmpdir(), 'ambion-pi-sessions');
}

/** One file store for each directory in this process. A session file opens once. */
const stores = new Map<string, Promise<DiskStore>>();

interface DiskStore {
	readonly repo: JsonlSessionRepo;
	/** The folder label for one room and seat. */
	cwd(scope: SessionScope): string;
}

async function storeFor(dir: string): Promise<DiskStore> {
	const [{ NodeExecutionEnv }, { join }] = await Promise.all([
		import('@earendil-works/pi-agent-core/node'),
		import('node:path'),
	]);
	const repo = new JsonlSessionRepo({
		fileSystem: new NodeExecutionEnv({ cwd: dir }),
		sessionsRoot: dir,
	});
	return {
		repo,
		cwd: (scope) => join(dir, encodeURIComponent(scope.room), encodeURIComponent(scope.seat)),
	};
}

/**
 * Sessions as JSONL files under `dir`, a folder for each room and seat. A
 * function names the directory on first use.
 */
export function diskSessions(dir: string | (() => Promise<string>)): PiSessions {
	const store = async (): Promise<DiskStore> => {
		const resolved = typeof dir === 'string' ? dir : await dir();
		let found = stores.get(resolved);
		if (found === undefined) {
			found = storeFor(resolved);
			stores.set(resolved, found);
		}
		return found;
	};
	return {
		create: async (scope, id, context) => {
			const { repo, cwd } = await store();
			return createWithFallback(
				(wanted) =>
					repo.create(
						{ cwd: cwd(scope), ...(wanted === undefined ? {} : { id: wanted }) },
						context,
					),
				id,
			);
		},
		open: async (scope, id, context) => {
			const { repo, cwd } = await store();
			return openListed<JsonlSessionMetadata>(
				() => repo.list({ cwd: cwd(scope) }, context),
				(metadata) => repo.open(metadata, context),
				id,
			);
		},
	};
}
