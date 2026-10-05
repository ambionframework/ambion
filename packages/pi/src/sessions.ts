/**
 * Where a seat keeps its Pi sessions.
 *
 * A session holds the transcript of one exchange for one seat. It is one
 * pi-durable `Storage` with one root conversation. The executor creates it
 * under the id of the activation that began it, and reopens it by that id
 * when the room names it in `spec.resume`. A session that the store does not
 * hold opens as nothing, and the activation begins a fresh one. A session
 * that the store cannot read fails to open, and the executor records the
 * cause in the trace before it begins a fresh one.
 *
 * - **Memory.** `memorySessions()` keeps each session in a `MemoryStorage`.
 *   It keeps the two newest sessions of each room and seat, as long as the
 *   store lives.
 * - **Disk.** `diskSessions(dir)` keeps each session as a JSONL storage in
 *   the folder `dir/<room>/<seat>/<id>`. A restart on the same disk reopens
 *   it. A session the disk refuses to create stays in memory, and `create`
 *   reports the cause. The store loads the Node
 *   file system on first use, so the entry of this package loads on a host
 *   with no disk.
 */
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable';

/** The seat a session belongs to. */
export interface SessionScope {
	readonly room: string;
	readonly seat: string;
}

/** A new session, and the id it holds. */
export interface CreatedSession {
	readonly id: string;
	readonly storage: Storage;
	/** The message of the error that made the store keep the session in memory. Absent on the store's own storage. */
	readonly fallback?: string;
}

/** A seat's store of Pi sessions. */
export interface PiSessions {
	/**
	 * Create a session under `id`. When the store already holds that id, the
	 * session gets a fresh id, and `created.id` names it.
	 */
	create(scope: SessionScope, id: string): Promise<CreatedSession>;
	/**
	 * Open the session `id`. Nothing, when the store does not hold it. It
	 * rejects when the store holds no copy and cannot read its own.
	 */
	open(scope: SessionScope, id: string): Promise<Storage | undefined>;
}

/**
 * A memory storage that outlives the close of its harness. The harness
 * closes its storage with itself, and the next activation of the exchange
 * reopens the same session.
 */
class KeptMemory extends MemoryStorage {
	override close(): Promise<void> {
		return Promise.resolve();
	}
}

/** A storage in memory that a harness close leaves open. */
export function memoryStorage(): Storage {
	return new KeptMemory();
}

/**
 * How many sessions the memory store keeps for each room and seat: the
 * session of the exchange that runs, and the session of the exchange before
 * it, which its summary can still continue.
 */
const KEPT_IN_MEMORY = 2;

/**
 * Sessions in memory. The store keeps the two newest sessions of each room
 * and seat, and deletes the rest: no later activation continues them.
 */
export function memorySessions(): PiSessions {
	const seats = new Map<string, Map<string, Storage>>();
	const seatOf = (scope: SessionScope): Map<string, Storage> => {
		const key = `${scope.room}\u0000${scope.seat}`;
		let seat = seats.get(key);
		if (seat === undefined) {
			seat = new Map();
			seats.set(key, seat);
		}
		return seat;
	};
	return {
		create: (scope, id) => {
			const seat = seatOf(scope);
			const storage = memoryStorage();
			const held = seat.has(id) ? `${id}-${crypto.randomUUID()}` : id;
			seat.set(held, storage);
			// A map keeps insertion order: the oldest session comes first.
			for (const old of [...seat.keys()].slice(0, -KEPT_IN_MEMORY)) seat.delete(old);
			return Promise.resolve({ id: held, storage });
		},
		open: (scope, id) => Promise.resolve(seatOf(scope).get(id)),
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

/** The folder of one session, and nothing else the Node modules give. */
async function folderOf(dir: string, scope: SessionScope, id: string): Promise<string> {
	const { join } = await import('node:path');
	return join(
		dir,
		encodeURIComponent(scope.room),
		encodeURIComponent(scope.seat),
		encodeURIComponent(id),
	);
}

/** The Node JSONL storage on `folder`. The module loads on first use. */
async function jsonlStorage(folder: string): Promise<Storage> {
	const [{ openNodeJsonlStorage }, { BACKGROUND_CONTEXT }] = await Promise.all([
		import('@earendil-works/pi-durable/storage/jsonl/node'),
		import('@earendil-works/chord/context'),
	]);
	return openNodeJsonlStorage(folder, BACKGROUND_CONTEXT);
}

/** Whether `folder` is a directory. */
async function isDirectory(folder: string): Promise<boolean> {
	const { stat } = await import('node:fs/promises');
	return stat(folder).then(
		(stats) => stats.isDirectory(),
		() => false,
	);
}

/**
 * Sessions as JSONL storages under `dir`, a folder for each room, seat, and
 * session. A function names the directory on first use. The store is a
 * cache: when the disk refuses a session, the store keeps it in memory, and
 * the activation runs on. The store reports the cause to its caller.
 */
export function diskSessions(dir: string | (() => Promise<string>)): PiSessions {
	const fallback = memorySessions();
	const root = async (): Promise<string> => (typeof dir === 'string' ? dir : dir());
	return {
		create: async (scope, id) => {
			try {
				const base = await root();
				const held = (await isDirectory(await folderOf(base, scope, id)))
					? `${id}-${crypto.randomUUID()}`
					: id;
				return { id: held, storage: await jsonlStorage(await folderOf(base, scope, held)) };
			} catch (error) {
				return { ...(await fallback.create(scope, id)), fallback: messageOf(error) };
			}
		},
		open: async (scope, id) => {
			try {
				const folder = await folderOf(await root(), scope, id);
				// The storage creates a missing folder: a session the disk does not hold opens as nothing.
				if (await isDirectory(folder)) return await jsonlStorage(folder);
			} catch (error) {
				// A session that a refused create kept in memory is still there to open.
				const kept = await fallback.open(scope, id);
				if (kept !== undefined) return kept;
				throw error;
			}
			return fallback.open(scope, id);
		},
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
