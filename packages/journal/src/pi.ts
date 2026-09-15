/** Pi transcript storage over named Ambion journals. */

import type {
	BranchBounds,
	Entry,
	EntryQuery,
	LanePointer,
	LaneRecord,
	LogItem,
	NewRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	RecordQuery,
	SessionMetadata,
	SessionStats,
	SessionStorage,
} from '@earendil-works/pi-agent-core';
import { Session, SessionError } from '@earendil-works/pi-agent-core';
import type { SessionOpener } from './pi-types.ts';
import type { JournalOpener, JournalStorage, StoragePosition } from './storage.ts';
import { namespaced } from './storage.ts';

export type { SessionOpener } from './pi-types.ts';

type Mutation =
	| { id: string; kind: 'metadata'; metadata: SessionMetadata }
	| { id: string; kind: 'entry'; entry: Entry; lane: string }
	| { id: string; kind: 'record'; record: LaneRecord }
	| { id: string; kind: 'lane'; operation: 'create' | 'move'; lane: string; leafId: string | null }
	| { id: string; kind: 'name'; name: string | null }
	| { id: string; kind: 'label'; targetId: string; label: string | null };

interface State {
	metadata: SessionMetadata | undefined;
	position: StoragePosition;
	sequence: number;
	readonly entries: Entry[];
	readonly entriesById: Map<string, Entry>;
	readonly records: LaneRecord[];
	readonly recordsById: Map<string, LaneRecord>;
	readonly usedIds: Set<string>;
	readonly entryMutations: Map<string, Extract<Mutation, { kind: 'entry' }>>;
	readonly lanes: Map<string, string | null>;
	readonly labels: Map<string, string>;
	readonly openOperations: Map<string, Map<string, OperationStartedRecord>>;
	readonly log: LogItem[];
	readonly mutations: Map<string, Mutation>;
	name: string | undefined;
	stats: SessionStats;
}

function storageError(message: string): SessionError {
	return new SessionError('storage', message);
}

function invalidEntry(message: string): SessionError {
	return new SessionError('invalid_entry', message);
}

function newState(): State {
	return {
		metadata: undefined,
		position: 0,
		sequence: 0,
		entries: [],
		entriesById: new Map(),
		records: [],
		recordsById: new Map(),
		usedIds: new Set(),
		entryMutations: new Map(),
		lanes: new Map([['main', null]]),
		labels: new Map(),
		openOperations: new Map(),
		log: [],
		mutations: new Map(),
		name: undefined,
		stats: { messageCount: 0, cachedTokens: 0, uncachedTokens: 0, totalTokens: 0, costTotal: 0 },
	};
}

function isMutation(value: unknown): value is Mutation {
	return typeof value === 'object' && value !== null && 'kind' in value && 'id' in value;
}

function requireSequence(state: State, sequence: number): void {
	if (sequence !== state.sequence + 1)
		throw invalidEntry(`Session mutation has non-consecutive seq ${sequence}`);
}

function requireUnused(state: State, id: string): void {
	if (state.usedIds.has(id)) {
		throw invalidEntry(`Session mutation contains duplicate id ${id}`);
	}
}

function applyEntry(state: State, mutation: Extract<Mutation, { kind: 'entry' }>): void {
	const { entry, lane } = mutation;
	state.sequence = entry.seq;
	state.entries.push(structuredClone(entry));
	state.entriesById.set(entry.id, structuredClone(entry));
	state.usedIds.add(entry.id);
	state.entryMutations.set(entry.id, clone(mutation));
	state.lanes.set(lane, entry.id);
	state.log.push({ kind: 'entry', seq: entry.seq, entry: structuredClone(entry) });
	if (entry.type === 'message') state.stats.messageCount += 1;
}

function applyRecord(state: State, mutation: Extract<Mutation, { kind: 'record' }>): void {
	const { record } = mutation;
	state.sequence = record.seq;
	state.records.push(structuredClone(record));
	state.recordsById.set(record.id, clone(record));
	state.usedIds.add(record.id);
	state.log.push({ kind: 'record', seq: record.seq, record: structuredClone(record) });
	if (record.type === 'operation_started') {
		state.openOperations.set(record.lane, new Map([[record.id, structuredClone(record)]]));
	}
	if (record.type === 'operation_finished')
		state.openOperations.get(record.lane)?.delete(record.runId);
	if (record.type === 'usage') {
		state.stats.cachedTokens += record.usage.cacheRead;
		state.stats.uncachedTokens += record.usage.input + record.usage.cacheWrite;
		state.stats.totalTokens += record.usage.totalTokens;
		state.stats.costTotal += record.usage.cost.total;
	}
}

function applyLane(state: State, mutation: Extract<Mutation, { kind: 'lane' }>): void {
	state.sequence += 1;
	state.lanes.set(mutation.lane, mutation.leafId);
	state.log.push({
		kind: 'lane',
		seq: state.sequence,
		lane: mutation.lane,
		leafId: mutation.leafId,
	});
}

function applyName(state: State, mutation: Extract<Mutation, { kind: 'name' }>): void {
	state.sequence += 1;
	state.name = mutation.name ?? undefined;
	state.log.push({ kind: 'fact', seq: state.sequence, fact: 'name', name: state.name });
}

function applyLabel(state: State, mutation: Extract<Mutation, { kind: 'label' }>): void {
	state.sequence += 1;
	if (mutation.label === null) state.labels.delete(mutation.targetId);
	else state.labels.set(mutation.targetId, mutation.label);
	state.log.push({
		kind: 'fact',
		seq: state.sequence,
		fact: 'label',
		targetId: mutation.targetId,
		label: mutation.label ?? undefined,
	});
}

function validateEntry(state: State, mutation: Extract<Mutation, { kind: 'entry' }>): void {
	requireSequence(state, mutation.entry.seq);
	requireUnused(state, mutation.entry.id);
	const leaf = state.lanes.get(mutation.lane);
	if (leaf === undefined) throw invalidEntry(`Entry references missing lane ${mutation.lane}`);
	if (mutation.entry.parentId !== leaf)
		throw invalidEntry('Entry does not chain to the lane leaf.');
	if (mutation.entry.parentId !== null && !state.entriesById.has(mutation.entry.parentId)) {
		throw invalidEntry(`Entry references missing parent ${mutation.entry.parentId}`);
	}
}

function validateRecord(state: State, mutation: Extract<Mutation, { kind: 'record' }>): void {
	requireSequence(state, mutation.record.seq);
	requireUnused(state, mutation.record.id);
	if (!state.lanes.has(mutation.record.lane))
		throw invalidEntry(`Record references missing lane ${mutation.record.lane}`);
	if (
		mutation.record.type === 'operation_started' &&
		state.openOperations.get(mutation.record.lane)?.size
	) {
		throw storageError(`Lane ${mutation.record.lane} already has an open operation.`);
	}
}

function validateLane(state: State, mutation: Extract<Mutation, { kind: 'lane' }>): void {
	if (mutation.operation === 'create' && state.lanes.has(mutation.lane))
		throw invalidEntry(`Lane already exists: ${mutation.lane}`);
	if (mutation.operation === 'move' && !state.lanes.has(mutation.lane))
		throw invalidEntry(`Lane not found: ${mutation.lane}`);
	if (mutation.leafId !== null && !state.entriesById.has(mutation.leafId))
		throw invalidEntry(`Lane references missing entry ${mutation.leafId}`);
}

function validate(state: State, mutation: Mutation): void {
	if (state.mutations.has(mutation.id))
		throw storageError(`Session mutation contains duplicate id ${mutation.id}.`);
	if (mutation.kind === 'metadata') {
		if (state.metadata !== undefined)
			throw storageError('Session journal contains more than one metadata entry.');
		return;
	}
	if (state.metadata === undefined) throw storageError('Session journal has no metadata entry.');
	if (mutation.kind === 'entry') {
		validateEntry(state, mutation);
		return;
	}
	if (mutation.kind === 'record') {
		validateRecord(state, mutation);
		return;
	}
	if (mutation.kind === 'lane') {
		validateLane(state, mutation);
		return;
	}
	if (mutation.kind === 'label' && !state.entriesById.has(mutation.targetId)) {
		throw invalidEntry(`Label references missing entry ${mutation.targetId}`);
	}
}

function apply(state: State, mutation: Mutation): void {
	validate(state, mutation);
	state.mutations.set(mutation.id, clone(mutation));
	if (mutation.kind === 'metadata') {
		state.metadata = clone(mutation.metadata);
		return;
	}
	switch (mutation.kind) {
		case 'entry':
			applyEntry(state, mutation);
			return;
		case 'record':
			applyRecord(state, mutation);
			return;
		case 'lane':
			applyLane(state, mutation);
			return;
		case 'name':
			applyName(state, mutation);
			return;
		case 'label':
			applyLabel(state, mutation);
	}
}

const RECOVERED = Symbol('recovered');

type WriteResult<T> = { readonly done: false } | { readonly done: true; readonly value: T };

function clone<T>(value: T): T {
	return structuredClone(value);
}

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

function matchesRecord(record: LaneRecord, query: RecordQuery): boolean {
	return (
		(query.lane === undefined || record.lane === query.lane) &&
		(query.type === undefined || record.type === query.type) &&
		(query.runId === undefined ||
			(record.type === 'operation_started'
				? record.id === query.runId
				: 'runId' in record && record.runId === query.runId)) &&
		(query.operationKind === undefined ||
			(record.type === 'operation_started' && record.intent.kind === query.operationKind)) &&
		(query.afterSeq === undefined || record.seq > query.afterSeq)
	);
}

function ordered<T>(items: readonly T[], order: 'oldestFirst' | 'newestFirst' | undefined): T[] {
	return order === 'oldestFirst' ? [...items] : [...items].reverse();
}

function limit<T>(items: T[], count: number | undefined): T[] {
	return count === undefined ? items : items.slice(0, count);
}

function validateLimit(value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
		throw new SessionError('invalid_query', 'limit must be a positive integer');
	}
}

function validateCursor(value: number | undefined): void {
	if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
		throw new SessionError('invalid_query', 'cursor sequence must be a non-negative integer');
	}
}

function sameEntry(entry: Entry, source: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
	return JSON.stringify(provisioned) === JSON.stringify(source);
}

function sameRecord(record: LaneRecord, source: NewRecord): boolean {
	const { seq: _seq, timestamp: _timestamp, ...newRecord } = record;
	return JSON.stringify(newRecord) === JSON.stringify(source);
}

function branchPath(state: State, start: string, bounds?: BranchBounds): Entry[] {
	const path: Entry[] = [];
	let entry = state.entriesById.get(start);
	if (entry === undefined) throw new SessionError('not_found', `Entry not found: ${start}`);
	while (entry !== undefined) {
		path.push(entry);
		if (
			entry.id === bounds?.stopAtId ||
			entry.type === bounds?.stopAtType ||
			entry.parentId === null
		)
			return path;
		entry = state.entriesById.get(entry.parentId);
	}
	throw invalidEntry('Session branch references a missing parent.');
}

function queryBranch(state: State, query: EntryQuery & BranchBounds & { start: string }): Entry[] {
	const branch =
		query.order === 'oldestFirst'
			? branchPath(state, query.start).reverse()
			: branchPath(state, query.start, query);
	const found: Entry[] = [];
	for (const entry of branch) {
		if (matchesEntry(entry, query)) found.push(entry);
		if (
			entry.id === query.stopAtId ||
			entry.type === query.stopAtType ||
			found.length === query.limit
		)
			break;
	}
	return clone(found);
}

function recoverEntry<TEntry extends Entry>(
	state: State,
	mutationId: string,
	source: ProvisionedEntry<TEntry>,
	lane: string,
): TEntry | undefined {
	const mutation = state.mutations.get(mutationId);
	if (mutation?.kind === 'entry') {
		if (mutation.lane === lane) return mutation.entry as TEntry;
		throw new SessionError('already_exists', `Session id already exists: ${source.id}`);
	}
	const entry = state.entriesById.get(source.id);
	if (entry === undefined) return undefined;
	const persisted = state.entryMutations.get(source.id);
	if (persisted?.lane === lane && sameEntry(entry, source)) return entry as TEntry;
	throw new SessionError('already_exists', `Session id already exists: ${source.id}`);
}

class JournalSessionStorage implements SessionStorage {
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
			if (!isMutation(stored.entry))
				throw storageError('Session journal contains an invalid mutation.');
			apply(this.projection, stored.entry);
			this.projection.position = stored.position;
		}
		if (read.entries.length === 0) this.projection.position = read.position;
		if (this.projection.metadata === undefined)
			throw storageError('Session journal has no metadata entry.');
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
		throw storageError('Session journal has different metadata.');
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
			if (!isMutation(stored.entry))
				throw storageError('Session storage returned an invalid mutation.');
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
			if (state.metadata === undefined)
				throw storageError('Session journal has no metadata entry.');
			return clone(state.metadata);
		});
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.read((state) => [...state.lanes].map(([lane, leafId]) => ({ lane, leafId })));
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		await this.write(
			(state, id) => {
				if (state.lanes.has(lane))
					throw new SessionError('already_exists', `Lane already exists: ${lane}`);
				if (at !== null && !state.entriesById.has(at))
					throw new SessionError('not_found', `Entry not found: ${at}`);
				return {
					mutation: { id, kind: 'lane', operation: 'create', lane, leafId: at },
					value: undefined,
				};
			},
			(state, id) => (state.mutations.has(id) ? RECOVERED : undefined),
		);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		await this.write(
			(state, id) => {
				if (!state.lanes.has(lane))
					throw new SessionError('invalid_lane', `Lane not found: ${lane}`);
				if (to !== null && !state.entriesById.has(to))
					throw new SessionError('not_found', `Entry not found: ${to}`);
				return {
					mutation: { id, kind: 'lane', operation: 'move', lane, leafId: to },
					value: undefined,
				};
			},
			(state, id) => (state.mutations.has(id) ? RECOVERED : undefined),
		);
	}

	async appendEntry<TEntry extends Entry>(
		newEntry: ProvisionedEntry<TEntry>,
		lane: string,
	): Promise<TEntry> {
		const source = clone(newEntry);
		return this.write(
			(state, id) => {
				const parentId = state.lanes.get(lane);
				if (parentId === undefined)
					throw new SessionError('invalid_lane', `Lane not found: ${lane}`);
				const previous = state.entriesById.get(source.id);
				if (previous !== undefined)
					throw new SessionError('already_exists', `Session id already exists: ${source.id}`);
				const entry = {
					...source,
					parentId,
					seq: state.sequence + 1,
					timestamp: Date.now(),
				} as unknown as TEntry;
				return { mutation: { id, kind: 'entry', entry, lane }, value: entry };
			},
			(state, id) => recoverEntry(state, id, source, lane),
		);
	}

	async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		const source = clone(newRecord);
		return this.write(
			(state, id) => {
				if (!state.lanes.has(source.lane))
					throw new SessionError('invalid_lane', `Lane not found: ${source.lane}`);
				if (state.recordsById.has(source.id) || state.entriesById.has(source.id)) {
					throw new SessionError('already_exists', `Session id already exists: ${source.id}`);
				}
				if (source.type === 'operation_started' && state.openOperations.get(source.lane)?.size) {
					throw storageError(`Lane ${source.lane} already has an open operation.`);
				}
				const record = {
					...source,
					seq: state.sequence + 1,
					timestamp: Date.now(),
				} as unknown as TRecord;
				return { mutation: { id, kind: 'record', record }, value: record };
			},
			(state, id) => {
				const mutation = state.mutations.get(id);
				if (mutation?.kind === 'record') return mutation.record as TRecord;
				const existing = state.recordsById.get(source.id);
				if (existing === undefined) return undefined;
				if (!sameRecord(existing, source)) {
					throw new SessionError('already_exists', `Session id already exists: ${source.id}`);
				}
				return existing as TRecord;
			},
		);
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

	async findEntriesOnBranch(
		query: EntryQuery & BranchBounds & { start: string },
	): Promise<Entry[]> {
		validateLimit(query.limit);
		validateCursor(query.cursor?.afterSeq);
		return this.read((state) => queryBranch(state, query));
	}

	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		validateLimit(query.limit);
		validateCursor(query.afterSeq);
		if (query.operationKind !== undefined && query.type !== 'operation_started') {
			throw new SessionError('invalid_query', 'operationKind requires type "operation_started"');
		}
		return this.read((state) =>
			clone(
				limit(
					ordered(
						state.records.filter((record) => matchesRecord(record, query)),
						query.order,
					),
					query.limit,
				),
			),
		);
	}

	async findOpenOperations(
		lane: string,
		options?: { limit?: number },
	): Promise<OperationStartedRecord[]> {
		validateLimit(options?.limit);
		return this.read((state) => {
			const operations = [...(state.openOperations.get(lane)?.values() ?? [])].reverse();
			return clone(limit(operations, options?.limit));
		});
	}

	async getLog(options?: { afterSeq?: number; limit?: number }): Promise<LogItem[]> {
		validateLimit(options?.limit);
		validateCursor(options?.afterSeq);
		return this.read((state) => {
			const items = state.log.filter(
				(item) => options?.afterSeq === undefined || item.seq > options.afterSeq,
			);
			return clone(limit(items, options?.limit));
		});
	}

	async getName(): Promise<string | undefined> {
		return this.read((state) => state.name);
	}

	async setName(name: string | undefined): Promise<void> {
		await this.write(
			(_state, id) => ({ mutation: { id, kind: 'name', name: name ?? null }, value: undefined }),
			(state, id) => (state.mutations.has(id) ? RECOVERED : undefined),
		);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.read((state) => state.labels.get(id));
	}

	async setLabel(targetId: string, label: string | undefined): Promise<void> {
		await this.write(
			(state, id) => {
				if (!state.entriesById.has(targetId))
					throw new SessionError('not_found', `Entry not found: ${targetId}`);
				return {
					mutation: { id, kind: 'label', targetId, label: label ?? null },
					value: undefined,
				};
			},
			(state, id) => (state.mutations.has(id) ? RECOVERED : undefined),
		);
	}

	async getStats(): Promise<SessionStats> {
		return this.read((state) => clone(state.stats));
	}
}

/** Pi sessions stored in collision-safe named journals. */
export function piSessions(journals: JournalOpener): SessionOpener {
	const sessions = namespaced(journals, 'ambion/pi-session');
	return {
		async open(id, parentId) {
			const metadata: SessionMetadata = {
				id,
				createdAt: Date.now(),
				...(parentId === undefined ? {} : { parentSessionId: parentId }),
			};
			const storage = new JournalSessionStorage(await sessions.open(id), metadata);
			await storage.initialize();
			return new Session(storage);
		},
	};
}
