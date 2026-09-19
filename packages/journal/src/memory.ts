import type {
	JournalOpener,
	JournalRead,
	JournalStorage,
	StoragePosition,
	StoredEntry,
} from './storage.ts';

class MemoryJournal implements JournalStorage {
	private readonly entries: StoredEntry[] = [];

	async read(after: StoragePosition): Promise<JournalRead> {
		const head = this.entries.at(-1)?.position;
		return {
			entries: structuredClone(this.entries.filter((stored) => stored.position > after)),
			// A read reports the highest position it scanned, and never one before `after`.
			position: head === undefined ? after : Math.max(after, head),
		};
	}

	async append(
		entry: unknown,
		expectedPosition: StoragePosition,
	): Promise<StoredEntry | undefined> {
		const head = this.entries.at(-1)?.position ?? 0;
		if (head !== expectedPosition) return undefined;
		const position = head + 1;
		const stored = { entry: structuredClone(entry), position };
		this.entries.push(stored);
		return structuredClone(stored);
	}
}

/** Independent in-memory journals, useful for one-process rooms and deterministic tests. */
export function memoryJournals(): JournalOpener {
	const journals = new Map<string, MemoryJournal>();
	return {
		async open(name) {
			let journal = journals.get(name);
			if (journal === undefined) {
				journal = new MemoryJournal();
				journals.set(name, journal);
			}
			return journal;
		},
	};
}
