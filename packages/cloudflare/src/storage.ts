/**
 * The Durable Object's SQLite as one native journal backend. Room records,
 * Pi sessions, and object metadata derive separate names from this backend.
 */
import type {
	JournalOpener,
	JournalStorage,
	Sql,
	SqlValue,
	StoragePosition,
} from '@ambionframework/journal';
import { namespaced, sqliteJournals } from '@ambionframework/journal';

/** The object's SQLite as the core reaches it. */
export function sqlOver(storage: SqlStorage): Sql {
	return {
		run(query, ...params) {
			storage.exec(query, ...params);
		},
		all(query, ...params) {
			return storage.exec(query, ...params).toArray() as Record<string, SqlValue>[];
		},
	};
}

/** One native journal backend over the object's SQLite. */
export function sqlStorage(state: DurableObjectState): JournalOpener {
	return sqliteJournals(sqlOver(state.storage.sql));
}

interface MetadataEvent<T extends object> {
	id: string;
	patch: Partial<T>;
	remove: readonly (keyof T)[];
}

export interface MetadataStore<T extends object> {
	read(): Promise<T>;
	change(
		change: (
			current: Readonly<T>,
		) => { patch?: Partial<T>; remove?: readonly (keyof T)[] } | undefined,
	): Promise<T>;
}

class MetadataJournal<T extends object> implements MetadataStore<T> {
	private tail = Promise.resolve();
	private current = {} as T;
	private cursor: StoragePosition = 0;
	private readonly events = new Set<string>();

	constructor(private readonly storage: Promise<JournalStorage>) {}

	read(): Promise<T> {
		return this.enqueue(async () => structuredClone(await this.refresh()));
	}

	change(
		change: (
			current: Readonly<T>,
		) => { patch?: Partial<T>; remove?: readonly (keyof T)[] } | undefined,
	): Promise<T> {
		return this.enqueue(() => this.changeNow(change));
	}

	private enqueue<TResult>(work: () => Promise<TResult>): Promise<TResult> {
		const next = this.tail.then(work, work);
		this.tail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async refresh(): Promise<T> {
		const found = await this.storage;
		const read = await found.read(this.cursor);
		for (const stored of read.entries) {
			this.cursor = stored.position;
			this.take(stored.entry as MetadataEvent<T>);
		}
		this.cursor = Math.max(this.cursor, read.position);
		return this.current;
	}

	private take(event: MetadataEvent<T>): void {
		if (this.events.has(event.id)) return;
		this.events.add(event.id);
		this.current = apply(this.current, event);
	}

	private async changeNow(
		change: (
			current: Readonly<T>,
		) => { patch?: Partial<T>; remove?: readonly (keyof T)[] } | undefined,
	): Promise<T> {
		const id = crypto.randomUUID();
		for (;;) {
			const current = await this.refresh();
			if (this.events.has(id)) return structuredClone(this.current);
			const update = change(structuredClone(current));
			if (update === undefined) return structuredClone(current);
			const event: MetadataEvent<T> = {
				id,
				patch: update.patch ?? {},
				remove: update.remove ?? [],
			};
			const landed = await this.append(event, this.cursor, id);
			if (landed === undefined) continue;
			this.cursor = landed.position;
			this.take(landed.entry as MetadataEvent<T>);
			return structuredClone(this.current);
		}
	}

	private async append(
		event: MetadataEvent<T>,
		position: StoragePosition,
		id: string,
	): Promise<import('@ambionframework/journal').StoredEntry | undefined> {
		const found = await this.storage;
		try {
			return await found.append(event, position);
		} catch (error) {
			const recovered = await this.refresh().catch(() => undefined);
			if (recovered !== undefined && this.events.has(id)) return undefined;
			throw error;
		}
	}
}

function apply<T extends object>(current: T, event: MetadataEvent<T>): T {
	const next: Record<string, unknown> = { ...current, ...event.patch };
	for (const key of event.remove) delete next[String(key)];
	return next as T;
}

export interface RoomMetadata {
	name?: string;
	people?: Record<string, unknown>;
}

export interface SeatMetadata {
	room?: string;
	seat?: string;
	activation?: string;
	phase?: 'pending' | 'running';
	wakes?: number;
	cuts?: number;
	hold?: boolean;
}

/** Durable state owned by a room object, under a name apart from its room record. */
export function roomMetadata(storage: JournalOpener): MetadataStore<RoomMetadata> {
	return new MetadataJournal(namespaced(storage, 'ambion/cloudflare/room').open('metadata'));
}

/** Durable state owned by a seat object, under a name apart from its Pi session. */
export function seatMetadata(storage: JournalOpener): MetadataStore<SeatMetadata> {
	return new MetadataJournal(namespaced(storage, 'ambion/cloudflare/seat').open('metadata'));
}
