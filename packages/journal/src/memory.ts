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
		return {
			entries: structuredClone(this.entries.filter((entry) => entry.position > after)),
			position: this.entries.at(-1)?.position ?? after,
		};
	}

	async append(
		entry: unknown,
		expectedPosition: StoragePosition,
	): Promise<StoredEntry | undefined> {
		const position = this.entries.at(-1)?.position ?? 0;
		if (position !== expectedPosition) return undefined;
		const stored = { entry: structuredClone(entry), position: position + 1 };
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
