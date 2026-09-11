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
 * hold every delivery acknowledged before them, every seq on the storage
 * is one message, one attempt at a wake or a draft runs at a time, and
 * nothing is pending once the room drains.
 */
import type { Clock } from '../../src/host.ts';
import type { Message, Seq } from '../../src/index.ts';
import type { LeaseRow } from '../../src/protocol.ts';
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
	/visit has ended|is stopped|not in this session|one name names one participant|is not seated|already running|has no composition|not in the runtime's catalog|already in this session|superseded/;

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
		stale?: () => boolean,
	): Promise<T | undefined> {
		const invoke = this.push({
			client,
			op,
			phase: 'invoke',
			...(key === undefined ? {} : { key }),
		});
		try {
			const value = await action();
			// An answer from a run that lost the name while the action ran is no answer:
			// the host knows the run is gone, and the client cannot tell what landed. The
			// check runs when the client resumes, so a run that lost the name between the
			// answer and the resume is counted too: that reads as one check fewer, never
			// as a wrong one.
			if (stale?.()) {
				this.push({
					client,
					op,
					phase: 'info',
					of: invoke.index,
					...(key === undefined ? {} : { key }),
					error: 'answered by a run that lost the name',
				});
				return undefined;
			}
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

/**
 * Every read is a prefix of the record, a client's reads move forward, and
 * every read holds every delivery acknowledged before the read was asked.
 */
function reads(history: History, record: readonly Message[]): string[] {
	const found: string[] = [];
	const last = new Map<string, number>();
	const acknowledged: { key: string; index: number }[] = [];
	for (const entry of history.entries) {
		if (entry.phase !== 'ok') continue;
		if (entry.op === 'deliver' && entry.key !== undefined) {
			acknowledged.push({ key: entry.key, index: entry.index });
		}
		if (entry.op !== 'read' || entry.seen === undefined) continue;
		found.push(...oneRead(entry, entry.seen, record, last.get(entry.client) ?? 0, acknowledged));
		last.set(entry.client, entry.seen.at(-1)?.seq ?? 0);
	}
	return found;
}

/** What one read breaks: the prefix, the client's forward motion, or a delivery acknowledged before it. */
function oneRead(
	entry: Entry,
	seen: NonNullable<Entry['seen']>,
	record: readonly Message[],
	lastSeen: number,
	acknowledged: readonly { key: string; index: number }[],
): string[] {
	const found: string[] = [];
	const who = `read #${entry.index} by ${entry.client}`;
	const cut = prefixBreak(seen, record);
	if (cut !== undefined) found.push(`${who} is not a prefix of the record at position ${cut}`);
	if ((seen.at(-1)?.seq ?? 0) < lastSeen) found.push(`${who} moved backwards`);
	const invoked = entry.of ?? entry.index;
	for (const own of acknowledged) {
		if (own.index < invoked && !seen.some((s) => s.key === own.key)) {
			found.push(`${who} lacks delivery ${own.key}, acknowledged before it was asked`);
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

/**
 * The rows that stand, the way the log reads them: a run row is the
 * fence, and an entry another run wrote past it is void. Run rows are
 * left out; the fold has no use for them.
 */
export function standing(rows: Checked['rows']): Checked['rows'] {
	const kept: { type: string; data: unknown }[] = [];
	let fence: string | undefined;
	for (const row of rows) {
		const data = row.data as { run?: string; written?: string };
		if (row.type === 'ambion/run') {
			fence = data.run;
			continue;
		}
		if (fence !== undefined && data.written !== undefined && data.written !== fence) continue;
		kept.push(row);
	}
	return kept;
}

/** Every seq on the storage names one message, among the entries that stand. */
function seqs(rows: Checked['rows']): string[] {
	const seen = new Map<number, number>();
	for (const row of standing(rows)) {
		if (row.type !== 'ambion/message') continue;
		const seq = (row.data as { seq: number }).seq;
		seen.set(seq, (seen.get(seq) ?? 0) + 1);
	}
	return [...seen]
		.filter(([, n]) => n > 1)
		.map(([seq, n]) => `seq ${seq} is on the storage ${n} times`);
}

/** One attempt at a wake or a draft runs at a time: the next claims only after the last ended. */
function exclusion(rows: Checked['rows']): string[] {
	const found: string[] = [];
	const running = new Map<string, string>();
	for (const row of standing(rows)) {
		if (row.type !== 'ambion/lease') continue;
		const lease = row.data as LeaseRow;
		const parsed = parseId(lease.id);
		if (parsed === undefined) continue;
		const attempt =
			parsed.kind === 'wake' ? activationId(parsed.seq, parsed.seat) : `close:${parsed.through}`;
		const held = running.get(attempt);
		if (lease.phase === 'running') {
			if (held !== undefined && held !== lease.id)
				found.push(`${lease.id} claimed while ${held} ran`);
			running.set(attempt, lease.id);
		} else if (held === lease.id) {
			running.delete(attempt);
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
