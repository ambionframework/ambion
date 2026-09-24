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
 *   `MemorySessionRepo`. It keeps the two newest sessions of each room and
 *   seat, as long as the store lives.
 * - **Disk.** `diskSessions(dir)` keeps each session as a JSONL file under
 *   `dir`, in a folder for each room and seat. A restart on the same disk
 *   reopens it. A session the disk refuses stays in memory. The store loads
 *   the Node file system on first use, so the entry of this package loads
 *   on a host with no disk.
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

/**
 * How many sessions the memory store keeps for each room and seat: the
 * session of the exchange that runs, and the session of the exchange before
 * it, which its summary can still continue.
 */
const KEPT_IN_MEMORY = 2;

/** The sessions of one room and seat in memory, newest last. */
interface MemorySeat {
	readonly repo: MemorySessionRepo;
	readonly created: SessionMetadata[];
}

/**
 * Delete each session older than the newest `KEPT_IN_MEMORY`. A session that
 * is still open stays, and the next create deletes it.
 */
async function prune(seat: MemorySeat, context: Context): Promise<void> {
	const old = seat.created.slice(0, -KEPT_IN_MEMORY);
	for (const metadata of old) {
		try {
			await seat.repo.delete(metadata, context);
			seat.created.splice(seat.created.indexOf(metadata), 1);
		} catch {
			// The session is still open. The next create tries again.
		}
	}
}

/**
 * Sessions in memory, one Pi repository for each room and seat. The store
 * keeps the two newest sessions of each room and seat, and deletes the
 * rest: no later activation continues them.
 */
export function memorySessions(): PiSessions {
	const seats = new Map<string, MemorySeat>();
	const seatOf = (scope: SessionScope): MemorySeat => {
		const key = `${scope.room}\u0000${scope.seat}`;
		let seat = seats.get(key);
		if (seat === undefined) {
			seat = { repo: new MemorySessionRepo(), created: [] };
			seats.set(key, seat);
		}
		return seat;
	};
	return {
		create: async (scope, id, context) => {
			const seat = seatOf(scope);
			const session = await createWithFallback(
				(wanted) => seat.repo.create(wanted === undefined ? {} : { id: wanted }, context),
				id,
			);
			seat.created.push(session.metadata);
			await prune(seat, context);
			return session;
		},
		open: (scope, id, context) => {
			const { repo } = seatOf(scope);
			return openListed(
				() => repo.list(undefined, context),
				(metadata) => repo.open(metadata, context),
				id,
			);
		},
	};
}

let defaultDir: Promise<string> | undefined;

/**
 * The directory for sessions when the host names none:
 * `ambion-pi-sessions-<uid>` in the OS temporary directory, private to the
 * user of this process.
 */
export function defaultSessionDir(): Promise<string> {
	if (defaultDir !== undefined) return defaultDir;
	const found = (async () => {
		const [{ tmpdir }, { join }] = await Promise.all([import('node:os'), import('node:path')]);
		// A host with no user ids, such as Windows, names no user.
		const name = ['ambion-pi-sessions', process.getuid?.()].filter((part) => part !== undefined);
		return privateDirectory(join(tmpdir(), name.join('-')));
	})();
	defaultDir = found;
	// The process keeps no refusal: the next session tries the directory again.
	found.catch(() => {
		defaultDir = undefined;
	});
	return found;
}

/**
 * Create the directory `path` with access for its owner only, and answer
 * it. A path that is no directory, or that another user owns, is refused:
 * the transcripts must not land where another user reads or writes them.
 */
export async function privateDirectory(path: string): Promise<string> {
	const { chmod, lstat, mkdir } = await import('node:fs/promises');
	await mkdir(path, { recursive: true, mode: 0o700 });
	const stats = await lstat(path);
	const uid = process.getuid?.();
	if (!stats.isDirectory() || (uid !== undefined && stats.uid !== uid)) {
		throw new Error(`The session directory '${path}' is not a directory this user owns.`);
	}
	if ((stats.mode & 0o077) !== 0) await chmod(path, 0o700);
	return path;
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
 * function names the directory on first use. The store is a cache: when
 * the disk refuses a session, the store keeps it in memory, and the
 * activation runs on.
 */
export function diskSessions(dir: string | (() => Promise<string>)): PiSessions {
	const fallback = memorySessions();
	const store = async (): Promise<DiskStore> => {
		const resolved = typeof dir === 'string' ? dir : await dir();
		let found = stores.get(resolved);
		if (found === undefined) {
			found = storeFor(resolved);
			stores.set(resolved, found);
		}
		return found;
	};
	const onDisk = async (scope: SessionScope, id: string, context: Context): Promise<Session> => {
		const { repo, cwd } = await store();
		return createWithFallback(
			(wanted) =>
				repo.create({ cwd: cwd(scope), ...(wanted === undefined ? {} : { id: wanted }) }, context),
			id,
		);
	};
	return {
		create: (scope, id, context) =>
			onDisk(scope, id, context).catch(() => fallback.create(scope, id, context)),
		open: async (scope, id, context) => {
			const found = await openListed<JsonlSessionMetadata>(
				async () => {
					const { repo, cwd } = await store();
					return repo.list({ cwd: cwd(scope) }, context);
				},
				async (metadata) => (await store()).repo.open(metadata, context),
				id,
			);
			return found ?? fallback.open(scope, id, context);
		},
	};
}
