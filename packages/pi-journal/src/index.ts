/** Pi transcript audit over named Ambion journals. */

import type { JournalOpener, JournalStorage, StoragePosition } from '@ambionframework/journal';
import { namespaced, scanned } from '@ambionframework/journal';
import type {
	AgentMessage,
	CustomEntry,
	Entry,
	EntryType,
	JsonValue,
	MessageEntry,
	SessionMetadata,
} from '@earendil-works/pi-agent-core';

/** The storage contract version this package writes on the run entry. */
export const STORAGE_VERSION = 1;

/** An entry the caller supplies before storage assigns its parent, seq, and time. */
export type AppendEntry<TEntry extends Entry = Entry> = TEntry extends Entry
	? Omit<TEntry, 'parentId' | 'seq' | 'timestamp'>
	: never;

/** A read over the ordered audit. */
export interface EntryQuery {
	type?: EntryType;
	customType?: string;
	order?: 'oldestFirst' | 'newestFirst';
	limit?: number;
	cursor?: { afterSeq: number };
}

/** One Pi transcript audit: an append-only record of session entries. */
export interface AuditSession {
	getMetadata(): Promise<SessionMetadata>;
	appendEntry<TEntry extends Entry>(entry: AppendEntry<TEntry>, lane?: string): Promise<TEntry>;
	appendMessage(message: AgentMessage): Promise<MessageEntry>;
	appendCustomEntry(customType: string, data?: JsonValue): Promise<CustomEntry>;
	getEntry(id: string): Promise<Entry | undefined>;
	findEntries(query?: EntryQuery): Promise<Entry[]>;
}

/** Opens one Pi transcript audit by id. */
export interface SessionOpener {
	open(id: string, parentId?: string): Promise<AuditSession>;
}

type Mutation =
	| { id: string; kind: 'metadata'; metadata: SessionMetadata }
	| { id: string; kind: 'entry'; entry: Entry };

interface State {
	metadata: SessionMetadata | undefined;
	position: StoragePosition;
	sequence: number;
	leaf: string | null;
	readonly entries: Entry[];
	readonly entriesById: Map<string, Entry>;
	readonly usedIds: Set<string>;
	readonly entryMutations: Map<string, Extract<Mutation, { kind: 'entry' }>>;
	readonly mutations: Map<string, Mutation>;
}

function fail(message: string): Error {
	return new Error(message);
}

function newState(): State {
	return {
		metadata: undefined,
		position: 0,
		sequence: 0,
		leaf: null,
		entries: [],
		entriesById: new Map(),
		usedIds: new Set(),
		entryMutations: new Map(),
		mutations: new Map(),
	};
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function isMutation(value: unknown): value is Mutation {
	return typeof value === 'object' && value !== null && 'kind' in value && 'id' in value;
}

function requireSequence(state: State, sequence: number): void {
	if (sequence !== state.sequence + 1)
		throw fail(`Session mutation has non-consecutive seq ${sequence}`);
}

function requireUnused(state: State, id: string): void {
	if (state.usedIds.has(id)) throw fail(`Session mutation contains duplicate id ${id}`);
}

function validateEntry(state: State, mutation: Extract<Mutation, { kind: 'entry' }>): void {
	requireSequence(state, mutation.entry.seq);
	requireUnused(state, mutation.entry.id);
	if (mutation.entry.parentId !== state.leaf)
		throw fail('Entry does not chain to the record leaf.');
}

function validate(state: State, mutation: Mutation): void {
	if (state.mutations.has(mutation.id))
		throw fail(`Session mutation contains duplicate id ${mutation.id}.`);
	if (mutation.kind === 'metadata') {
		if (state.metadata !== undefined)
			throw fail('Session journal contains more than one metadata entry.');
		return;
	}
	if (state.metadata === undefined) throw fail('Session journal has no metadata entry.');
	validateEntry(state, mutation);
}

function applyEntry(state: State, mutation: Extract<Mutation, { kind: 'entry' }>): void {
	const { entry } = mutation;
	state.sequence = entry.seq;
	state.leaf = entry.id;
	state.entries.push(clone(entry));
	state.entriesById.set(entry.id, clone(entry));
	state.usedIds.add(entry.id);
	state.entryMutations.set(entry.id, clone(mutation));
}

function apply(state: State, mutation: Mutation): void {
	validate(state, mutation);
	state.mutations.set(mutation.id, clone(mutation));
	if (mutation.kind === 'metadata') {
		state.metadata = clone(mutation.metadata);
		return;
	}
	applyEntry(state, mutation);
}

const RECOVERED = Symbol('recovered');

type WriteResult<T> = { readonly done: false } | { readonly done: true; readonly value: T };

function matchesEntry(entry: Entry, query: EntryQuery): boolean {
	return (
		(query.type === undefined || entry.type === query.type) &&
		(query.customType === undefined ||
			(entry.type === 'custom' && entry.customType === query.customType)) &&
		(query.cursor === undefined ||
			(query.order === 'oldestFirst'
				? entry.seq > query.cursor.afterSeq
				: entry.seq < query.cursor.afterSeq))
	);
}

function ordered(items: readonly Entry[], order: EntryQuery['order']): Entry[] {
	return order === 'oldestFirst' ? [...items] : [...items].reverse();
}

function limit<T>(items: T[], count: number | undefined): T[] {
	return count === undefined ? items : items.slice(0, count);
}

function validateLimit(value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value <= 0))
		throw fail('limit must be a positive integer');
}

function validateCursor(value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 0))
		throw fail('cursor sequence must be a non-negative integer');
}

function sameEntry(entry: Entry, source: AppendEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
	return JSON.stringify(provisioned) === JSON.stringify(source);
}

function recoverEntry<TEntry extends Entry>(
	state: State,
	mutationId: string,
	source: AppendEntry<TEntry>,
): TEntry | undefined {
	const mutation = state.mutations.get(mutationId);
	if (mutation?.kind === 'entry') return mutation.entry as TEntry;
	const entry = state.entriesById.get(source.id);
	if (entry === undefined) return undefined;
	if (sameEntry(entry, source)) return entry as TEntry;
	throw fail(`Session id already exists: ${source.id}`);
}

class JournalAuditSession implements AuditSession {
	private readonly projection = newState();
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly storage: JournalStorage,
		private readonly metadata: SessionMetadata,
	) {}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.pending.then(operation, operation);
		this.pending = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private read<T>(access: (state: State) => T): Promise<T> {
		return this.enqueue(async () => access(await this.refresh()));
	}

	private async refresh(): Promise<State> {
		const read = await this.storage.read(this.projection.position);
		for (const stored of read.entries) {
			if (!isMutation(stored.entry)) throw fail('Session journal contains an invalid mutation.');
			apply(this.projection, stored.entry);
			this.projection.position = scanned(this.projection.position, stored.position);
		}
		this.projection.position = scanned(this.projection.position, read.position);
		if (this.projection.metadata === undefined)
			throw fail('Session journal has no metadata entry.');
		return this.projection;
	}

	async initialize(): Promise<void> {
		const mutation: Mutation = {
			id: crypto.randomUUID(),
			kind: 'metadata',
			metadata: clone(this.metadata),
		};
		for (;;) {
			const read = await this.storage.read(0);
			if (this.hasMetadata(read.entries)) return;
			if (await this.appendMetadata(mutation, read.position)) return;
		}
	}

	private hasMetadata(entries: readonly { entry: unknown }[]): boolean {
		if (entries.length === 0) return false;
		const first = entries[0]?.entry;
		if (isMutation(first) && first.kind === 'metadata' && first.metadata.id === this.metadata.id)
			return true;
		throw fail('Session journal has different metadata.');
	}

	private async appendMetadata(mutation: Mutation, position: StoragePosition): Promise<boolean> {
		try {
			return (await this.storage.append(mutation, position)) !== undefined;
		} catch (error) {
			if (await this.metadataRecovered(mutation.id)) return true;
			throw error;
		}
	}

	private async metadataRecovered(id: string): Promise<boolean> {
		const read = await this.storage.read(0).catch(() => undefined);
		return read?.entries.some((entry) => isMutation(entry.entry) && entry.entry.id === id) ?? false;
	}

	private write<T>(
		create: (state: State, id: string) => { mutation: Mutation; value: T },
		recover: (state: State, id: string) => T | typeof RECOVERED | undefined,
	): Promise<T> {
		return this.enqueue(() => this.writeNow(create, recover));
	}

	private async writeNow<T>(
		create: (state: State, id: string) => { mutation: Mutation; value: T },
		recover: (state: State, id: string) => T | typeof RECOVERED | undefined,
	): Promise<T> {
		const id = crypto.randomUUID();
		for (;;) {
			const state = await this.refresh();
			const confirmed = this.recovered(recover(state, id));
			if (confirmed.done) return confirmed.value;
			const next = create(state, id);
			validate(state, next.mutation);
			const landed = await this.append(next, state.position, recover, id);
			if (landed.done) return landed.value;
		}
	}

	private recovered<T>(value: T | typeof RECOVERED | undefined): WriteResult<T> {
		if (value === RECOVERED) return { done: true, value: undefined as T };
		return value === undefined ? { done: false } : { done: true, value: clone(value) };
	}

	private async append<T>(
		next: { mutation: Mutation; value: T },
		position: StoragePosition,
		recover: (state: State, id: string) => T | typeof RECOVERED | undefined,
		id: string,
	): Promise<WriteResult<T>> {
		try {
			const stored = await this.storage.append(next.mutation, position);
			if (stored === undefined) return { done: false };
			if (!isMutation(stored.entry)) throw fail('Session storage returned an invalid mutation.');
			apply(this.projection, stored.entry);
			this.projection.position = stored.position;
			return { done: true, value: clone(next.value) };
		} catch (error) {
			const state = await this.refresh().catch(() => undefined);
			const recovered: WriteResult<T> =
				state === undefined ? { done: false } : this.recovered(recover(state, id));
			if (recovered.done) return recovered;
			throw error;
		}
	}

	async getMetadata(): Promise<SessionMetadata> {
		return this.read((state) => {
			if (state.metadata === undefined) throw fail('Session journal has no metadata entry.');
			return clone(state.metadata);
		});
	}

	async appendEntry<TEntry extends Entry>(
		newEntry: AppendEntry<TEntry>,
		_lane?: string,
	): Promise<TEntry> {
		const source = clone(newEntry);
		return this.write(
			(state, id) => {
				if (state.entriesById.get(source.id) !== undefined)
					throw fail(`Session id already exists: ${source.id}`);
				const entry = {
					...source,
					parentId: state.leaf,
					seq: state.sequence + 1,
					timestamp: Date.now(),
				} as unknown as TEntry;
				return { mutation: { id, kind: 'entry', entry }, value: entry };
			},
			(state, id) => recoverEntry(state, id, source),
		);
	}

	async appendMessage(message: AgentMessage): Promise<MessageEntry> {
		return this.appendEntry<MessageEntry>({ id: crypto.randomUUID(), type: 'message', message });
	}

	async appendCustomEntry(customType: string, data?: JsonValue): Promise<CustomEntry> {
		return this.appendEntry<CustomEntry>({
			id: crypto.randomUUID(),
			type: 'custom',
			customType,
			data,
		});
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		return this.read((state) => {
			const entry = state.entriesById.get(id);
			return entry === undefined ? undefined : clone(entry);
		});
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		validateLimit(query.limit);
		validateCursor(query.cursor?.afterSeq);
		return this.read((state) =>
			clone(
				limit(
					ordered(
						state.entries.filter((entry) => matchesEntry(entry, query)),
						query.order,
					),
					query.limit,
				),
			),
		);
	}
}

/** Pi transcript audits stored in collision-safe named journals. */
export function piSessions(journals: JournalOpener): SessionOpener {
	const sessions = namespaced(journals, 'ambion/pi-session');
	return {
		async open(id, parentId) {
			const metadata: SessionMetadata = {
				id,
				createdAt: Date.now(),
				storageVersion: STORAGE_VERSION,
				...(parentId === undefined ? {} : { parentSessionId: parentId }),
			};
			const session = new JournalAuditSession(await sessions.open(id), metadata);
			await session.initialize();
			return session;
		},
	};
}
