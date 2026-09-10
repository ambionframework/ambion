/**
 * A history of what the clients of a room asked for and what they heard
 * back, and the checks that hold it to the record. Every host action is
 * one invocation, then one of three outcomes: `ok`, the action landed;
 * `fail`, the room refused it and nothing landed; `info`, the client never
 * learned, because the storage, the wire or the process failed under it.
 *
 * The checks are the guarantees `docs/durability.md` states, read off the
 * history and the log together: an acknowledged delivery is on the record
 * once, a delivery in doubt is on it at most once, a refused one never,
 * every read is a prefix of the record, a client's reads move forward and
 * hold what it delivered, every seq on the storage is one message, one
 * attempt at a wake runs at a time, and nothing is pending once the room
 * drains.
 */
import type { Clock, LeaseRow, Message, Seq } from '../../src/index.ts';
import type { RoomState } from '../../src/room/fold.ts';
import { activationId, parseId } from '../../src/room/lease.ts';

export type Outcome = 'ok' | 'fail' | 'info';

export interface Entry {
	index: number;
	client: string;
	op: string;
	/** The delivery this entry is about, for a `deliver`. */
	key?: string;
	phase: 'invoke' | Outcome;
	/** The invocation this outcome answers, for an outcome. */
	of?: number;
	at: number;
	/** What an `ok` read saw: the seqs and keys of the record, in order. */
	seen?: { seq: Seq; key: string | undefined }[];
	error?: string;
}

/** The room said no, and nothing landed. Anything else is an outcome the client cannot tell. */
const DEFINITIVE =
	/visit has ended|is stopped|not in this session|one name names one participant|is not seated|already running|has no composition|not in the runtime's catalog|already in this session/;

export class History {
	readonly entries: Entry[] = [];

	constructor(private readonly clock: Clock) {}

	/** One host action, recorded: its invocation, then what the client heard back. */
	async run<T>(
		client: string,
		op: string,
		key: string | undefined,
		action: () => Promise<T>,
		seen?: (value: T) => Entry['seen'],
	): Promise<T | undefined> {
		const invoke = this.push({
			client,
			op,
			phase: 'invoke',
			...(key === undefined ? {} : { key }),
		});
		try {
			const value = await action();
			this.push({
				client,
				op,
				phase: 'ok',
				of: invoke.index,
				...(key === undefined ? {} : { key }),
				...(seen === undefined ? {} : { seen: seen(value) }),
				...(typeof value === 'string' ? { error: value } : {}),
			});
			return value;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.push({
				client,
				op,
				phase: DEFINITIVE.test(message) ? 'fail' : 'info',
				of: invoke.index,
				...(key === undefined ? {} : { key }),
				error: message,
			});
			return undefined;
		}
	}

	private push(entry: Omit<Entry, 'index' | 'at'>): Entry {
		const full: Entry = { ...entry, index: this.entries.length, at: this.clock.now() };
		this.entries.push(full);
		return full;
	}

	/** The history, one line per entry, for a failure message. */
	describe(): string {
		return this.entries
			.map((e) => {
				const key = e.key === undefined ? '' : ` ${e.key}`;
				const seen = e.seen === undefined ? '' : ` [${e.seen.map((s) => s.seq).join(' ')}]`;
				const error = e.error === undefined ? '' : ` (${e.error})`;
				const at = new Date(e.at).toISOString().slice(11, 23);
				return `#${e.index} ${at} ${e.client} ${e.op}${key} ${e.phase}${seen}${error}`;
			})
			.join('\n');
	}
}

export interface Checked {
	/** The record the room holds at the end. */
	record: readonly Message[];
	/** Every row on the storage, in append order. */
	rows: readonly { type: string; data: unknown }[];
	/** The fold at the end, after the drain. */
	state: RoomState;
}

/** Every guarantee the history and the record break, as one line each. Empty when all hold. */
export function violations(history: History, checked: Checked): string[] {
	const found: string[] = [];
	found.push(...deliveries(history, checked.record));
	found.push(...reads(history, checked.record));
	found.push(...seqs(checked.rows));
	found.push(...exclusion(checked.rows));
	found.push(...drained(checked.state));
	return found;
}

/** An acknowledged delivery is on the record once; one in doubt at most once; a refused one never. */
function deliveries(history: History, record: readonly Message[]): string[] {
	const found: string[] = [];
	const outcomes = new Map<string, Set<Outcome>>();
	for (const entry of history.entries) {
		if (entry.op !== 'deliver' || entry.phase === 'invoke' || entry.key === undefined) continue;
		outcomes.set(entry.key, new Set([...(outcomes.get(entry.key) ?? []), entry.phase]));
	}
	for (const [key, seen] of outcomes) {
		const landed = record.filter((m) => m.key === key).length;
		if (seen.has('ok') && landed !== 1)
			found.push(`delivery ${key} acknowledged, on the record ${landed} times`);
		if (!seen.has('ok') && seen.has('info') && landed > 1)
			found.push(`delivery ${key} in doubt, on the record ${landed} times`);
		if (!seen.has('ok') && !seen.has('info') && landed !== 0)
			found.push(`delivery ${key} refused, on the record ${landed} times`);
	}
	return found;
}

/** Every read is a prefix of the record, a client's reads move forward, and they hold what it delivered. */
function reads(history: History, record: readonly Message[]): string[] {
	const found: string[] = [];
	const last = new Map<string, number>();
	const delivered = new Map<string, { key: string; index: number }[]>();
	for (const entry of history.entries) {
		if (entry.phase !== 'ok') continue;
		if (entry.op === 'deliver' && entry.key !== undefined) {
			const own = delivered.get(entry.client) ?? [];
			delivered.set(entry.client, [...own, { key: entry.key, index: entry.index }]);
		}
		if (entry.op !== 'read' || entry.seen === undefined) continue;
		found.push(...oneRead(entry, entry.seen, record, last.get(entry.client) ?? 0, delivered));
		last.set(entry.client, entry.seen.at(-1)?.seq ?? 0);
	}
	return found;
}

/** What one read breaks: the prefix, the client's forward motion, or the client's own deliveries. */
function oneRead(
	entry: Entry,
	seen: NonNullable<Entry['seen']>,
	record: readonly Message[],
	lastSeen: number,
	delivered: ReadonlyMap<string, { key: string; index: number }[]>,
): string[] {
	const found: string[] = [];
	const who = `read #${entry.index} by ${entry.client}`;
	const cut = prefixBreak(seen, record);
	if (cut !== undefined) found.push(`${who} is not a prefix of the record at position ${cut}`);
	if ((seen.at(-1)?.seq ?? 0) < lastSeen) found.push(`${who} moved backwards`);
	const invoked = entry.of ?? entry.index;
	for (const own of delivered.get(entry.client) ?? []) {
		if (own.index < invoked && !seen.some((s) => s.key === own.key)) {
			found.push(`${who} lacks its own delivery ${own.key}`);
		}
	}
	return found;
}

/** The first position where what a read saw differs from the record, or nothing for a prefix. */
function prefixBreak(
	seen: NonNullable<Entry['seen']>,
	record: readonly Message[],
): number | undefined {
	for (const [i, item] of seen.entries()) {
		const actual = record[i];
		if (actual?.seq !== item.seq || actual.key !== item.key) return i;
	}
	return undefined;
}

/** Every seq on the storage names one message. */
function seqs(rows: Checked['rows']): string[] {
	const seen = new Map<number, number>();
	for (const row of rows) {
		if (row.type !== 'ambion/message') continue;
		const seq = (row.data as { seq: number }).seq;
		seen.set(seq, (seen.get(seq) ?? 0) + 1);
	}
	return [...seen]
		.filter(([, n]) => n > 1)
		.map(([seq, n]) => `seq ${seq} is on the storage ${n} times`);
}

/** One attempt at a wake runs at a time: the next claims only after the last ended. */
function exclusion(rows: Checked['rows']): string[] {
	const found: string[] = [];
	const running = new Map<string, string>();
	for (const row of rows) {
		if (row.type !== 'ambion/lease') continue;
		const lease = row.data as LeaseRow;
		const parsed = parseId(lease.id);
		if (parsed?.kind !== 'wake') continue;
		const wake = activationId(parsed.seq, parsed.seat);
		const held = running.get(wake);
		if (lease.phase === 'running') {
			if (held !== undefined && held !== lease.id)
				found.push(`${lease.id} claimed while ${held} ran`);
			running.set(wake, lease.id);
		} else if (held === lease.id) {
			running.delete(wake);
		}
	}
	return found;
}

/** Once the room drained, nothing runs, nothing is pending, and nothing is owed. */
function drained(state: RoomState): string[] {
	const found: string[] = [];
	for (const lease of state.leases.values()) {
		if (lease.phase === 'running') found.push(`${lease.id} still runs after the drain`);
	}
	for (const wake of state.pending) found.push(`${wake.id} still pending after the drain`);
	for (const owed of state.owed)
		found.push(`a summary for ${owed.person} still owed after the drain`);
	return found;
}
