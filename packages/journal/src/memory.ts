import {
	type JournalOpener,
	type JournalRead,
	type JournalStorage,
	positionRead,
	type StoragePosition,
	type StoredEntry,
} from './storage.ts';

class MemoryJournal implements JournalStorage {
	private readonly entries: StoredEntry[] = [];

	async read(after: StoragePosition): Promise<JournalRead> {
		return {
			entries: structuredClone(this.entries.filter((stored) => stored.position > after)),
			position: positionRead(after, this.entries.at(-1)?.position),
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
