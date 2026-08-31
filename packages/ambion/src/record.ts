/**
 * The record: every message a room committed, in the order it took a seq.
 *
 * It is the one thing a live room and a read of a stopped one share, so it
 * knows nothing about either: it replays a Pi session into memory, hands out
 * seqs one at a time, and persists on a chain that keeps commit order. What a
 * seat reads is a rendering of this (`render.ts`), never this itself.
 */
import type { Agent, Session as PiSession, SessionRepo } from '@earendil-works/pi-agent-core';
import type { Message, Seq } from './types.ts';

/** The record lives as custom entries of this type in a Pi session. */
const MESSAGE_ENTRY = 'ambion/message';

/**
 * The replayed record. Both a run and a read need it, and neither needs the
 * other's machinery, so it is the one thing they share.
 */
export class RecordStore {
	readonly entries: Message[] = [];
	readonly ready: Promise<PiSession>;
	lastSeq = 0;
	private tail: Promise<void> = Promise.resolve();
	/** The first write that failed since the last report. See `drained`. */
	private failure: Error | undefined;

	constructor(
		private readonly repo: SessionRepo,
		private readonly name: string,
	) {
		this.ready = this.open();
		// A host can hold a session and read nothing from it for hours, so
		// nothing may await `ready` for a long time. Mark the rejection handled
		// here: a repo that cannot open must surface at the call that needs the
		// store, and never as an unhandled rejection that ends the process.
		void this.ready.catch(() => {});
	}

	private async open(): Promise<PiSession> {
		const piSession = await openOrCreate(this.repo, this.name);
		const found = await piSession.findEntries();
		// findEntries does not promise append order; seq does.
		found.sort((a, b) => a.seq - b.seq);
		for (const entry of found) {
			if (entry.type !== 'custom' || entry.customType !== MESSAGE_ENTRY) continue;
			this.entries.push(entry.data as Message);
		}
		this.lastSeq = this.entries.at(-1)?.seq ?? 0;
		return piSession;
	}

	/**
	 * Take the next seq, synchronously — the say tool's conflict check and this
	 * push must share one tick, or a rival say could slip between them.
	 * Persistence follows in commit order on a write chain.
	 */
	append<T extends Message>(message: Omit<T, 'seq'>): T {
		const stamped = { ...message, seq: ++this.lastSeq } as T;
		this.entries.push(stamped);
		this.tail = this.tail
			.then(async () => {
				const piSession = await this.ready;
				await piSession.appendCustomEntry(MESSAGE_ENTRY, stamped);
			})
			// One write that fails must not stop the next one. The chain keeps
			// its order and remembers the failure; a repo that recovers writes
			// again. Without this catch the chain stays rejected for good.
			.catch((error: unknown) => {
				this.failure ??= toError(error);
			});
		return stamped;
	}

	/**
	 * Wait for the writes in flight, then report a failed one. The report
	 * clears it: the caller waiting on that write learns the record is
	 * incomplete, and the room keeps running rather than failing for ever.
	 */
	async drained(): Promise<void> {
		await this.tail;
		const failure = this.failure;
		if (failure === undefined) return;
		this.failure = undefined;
		throw failure;
	}

	since(cursor: Seq | undefined): Message[] {
		if (cursor === undefined) return [...this.entries];
		return this.entries.filter((message) => message.seq > cursor);
	}
}

/** Open an id into its Pi session, creating it on first open. */
export async function openOrCreate(
	repo: SessionRepo,
	id: string,
	parentSessionId?: string,
): Promise<PiSession> {
	const known = (await repo.list()).find((metadata) => metadata.id === id);
	if (known) return repo.open(known);
	return repo.create(parentSessionId ? { id, parentSessionId } : { id });
}

/** Every turn a model took, in the downstream session that owns it. */
export async function persistTurns(open: Promise<PiSession>, agent: Agent): Promise<void> {
	const piSeat = await open;
	await piSeat.appendCustomEntry('ambion/activation', { at: new Date().toISOString() });
	for (const message of agent.state.messages) {
		// Provider messages may carry undefined-valued fields, which Pi's
		// durability check rejects; a JSON round-trip drops them.
		await piSeat.appendMessage(JSON.parse(JSON.stringify(message)));
	}
}

export function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
