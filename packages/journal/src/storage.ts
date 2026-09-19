/**
 * A storage position starts at zero and strictly increases for each stored
 * entry. It orders stored entries, not journal envelopes.
 */
export type StoragePosition = number;

/**
 * One stored entry. Entries must be JSON-compatible data so native and SQL
 * storage preserve the same payload. The journal assigns its own `seq`
 * inside `entry`.
 */
export interface StoredEntry {
	readonly position: StoragePosition;
	readonly entry: unknown;
}

/** Ordered owned snapshots after one position, and the final position storage scanned. */
export interface JournalRead {
	readonly entries: readonly StoredEntry[];
	readonly position: StoragePosition;
}

/** One named, append-only journal over JSON-compatible entries. */
export interface JournalStorage {
	/**
	 * Return owned snapshots strictly after `after`, in storage order. The
	 * returned position is the highest position scanned, including entries an
	 * adapter filtered out.
	 */
	read(after: StoragePosition): Promise<JournalRead>;
	/**
	 * Atomically compare the current head with `expectedPosition`, then append
	 * at the next position. A mismatch writes nothing and returns `undefined`;
	 * success returns an owned snapshot of the stored entry.
	 */
	append(entry: unknown, expectedPosition: StoragePosition): Promise<StoredEntry | undefined>;
}

/** Opens the named storage for a journal. */
export interface JournalOpener {
	open(name: string): Promise<JournalStorage>;
}

/** Separates arbitrary journal names under one storage backend. */
export function namespaced(storage: JournalOpener, namespace: string): JournalOpener {
	return {
		open: (name) => storage.open(JSON.stringify([namespace, name])),
	};
}

/** The position a read reports: the highest position it scanned, and never one before `after`. */
export function positionRead(
	after: StoragePosition,
	head: StoragePosition | undefined,
): StoragePosition {
	return head === undefined ? after : Math.max(after, head);
}
