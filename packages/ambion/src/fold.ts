/**
 * Every fact about the room, as a fold over the log.
 *
 * The log is the truth, and the room holds no fact beside it: the roster,
 * the reserve, the people, the open exchange, the closes, the leases, the
 * wakes still pending and the summaries still owed are each one function
 * over the entries. A room that replays the log folds the same state the
 * room that wrote it held, which is what lets a room resume where it
 * stopped.
 */
import { draftOver } from './assistant.ts';
import { type Exchange, openExchange } from './exchange.ts';
import { foldLeases, type LeaseState, type PendingWake, parseId, pendingWakes } from './lease.ts';
import type { LogEntry } from './log.ts';
import { foldPeople, type PersonState } from './presence.ts';
import { type Attention, isSummary, type Message, type Seq } from './types.ts';
import type { CloseRow, CompositionRow, EndReason, LeaseRow, SeatRow } from './wire.ts';

/** One agent on the roster: its name, what wakes it, and whether it is the assistant. */
interface RosterSeat {
	name: string;
	attention: Attention;
	assistant: boolean;
}

/** A summary one person is owed, and how the room has tried to write it. */
export interface Owed {
	person: string;
	/** The earliest question the message must reach back to. */
	from: Seq;
	/** The latest close it stands for. The draft id names this. */
	through: Seq;
	/** Every close the message stands for, by `through`. */
	closes: Seq[];
	/** How many drafts over these closes failed, expired, or were refused. */
	attempts: number;
	/** When the next draft may start, or undefined when it may start now. */
	notBefore: number | undefined;
}

export interface RoomState {
	readonly composition: CompositionRow | undefined;
	readonly roster: RosterSeat[];
	readonly reserve: SeatRow[];
	readonly people: Map<string, PersonState>;
	readonly exchange: Exchange | undefined;
	readonly closes: CloseRow[];
	readonly leases: Map<string, LeaseState>;
	readonly pending: PendingWake[];
	readonly owed: Owed[];
	readonly messages: readonly Message[];
	readonly lastSeq: Seq;
}

export interface FoldOptions {
	/** How long the room waits before it drafts again, after `attempt` failed drafts. */
	backoff(attempt: number): number;
}

/** The entries, sorted by kind. */
function sorted(entries: readonly LogEntry[]) {
	const messages: Message[] = [];
	const closes: CloseRow[] = [];
	const leaseRows: LeaseRow[] = [];
	let composition: CompositionRow | undefined;
	for (const entry of entries) {
		if (entry.type === 'message') messages.push(entry.message);
		else if (entry.type === 'close') closes.push(entry.close);
		else if (entry.type === 'lease') leaseRows.push(entry.lease);
		else composition = entry.composition;
	}
	return { messages, closes, leaseRows, composition };
}

export function foldRoom(entries: readonly LogEntry[], options: FoldOptions): RoomState {
	const { messages, closes, leaseRows, composition } = sorted(entries);
	const people = foldPeople(messages);
	const roster = foldRoster(composition, messages);
	const leases = foldLeases(leaseRows);
	const assistant = composition?.assistant ?? '';
	const isPerson = (name: string) => people.has(name);
	return {
		composition,
		roster,
		reserve:
			composition?.available.filter((seat) => !roster.some((s) => s.name === seat.name)) ?? [],
		people,
		exchange: openExchange(messages, closes, isPerson),
		closes,
		leases,
		pending: pendingWakes(messages, closes, leases, assistant, new Set(roster.map((s) => s.name))),
		owed: foldOwed(closes, messages, leases, { assistant, isPerson, backoff: options.backoff }),
		messages,
		lastSeq: messages.at(-1)?.seq ?? 0,
	};
}

/** The latest composition, then every seating and unseating after it, in order. */
function foldRoster(
	composition: CompositionRow | undefined,
	messages: readonly Message[],
): RosterSeat[] {
	if (composition === undefined) return [];
	const roster: RosterSeat[] = [
		...composition.agents.map((seat) => ({ ...seat, assistant: false })),
		{ name: composition.assistant, attention: 'none' as const, assistant: true },
	];
	for (const message of messages) {
		if (message.seq > composition.after) reseat(roster, message);
	}
	return roster;
}

/** One seating or unseating applied to the roster. Any other message changes nothing. */
function reseat(roster: RosterSeat[], message: Message): void {
	if (message.kind !== 'seated' && message.kind !== 'unseated') return;
	const at = roster.findIndex((seat) => seat.name === message.from);
	if (at >= 0) roster.splice(at, 1);
	if (message.kind === 'seated') {
		roster.push({
			name: message.from,
			attention: message.attention ?? 'broadcast',
			assistant: false,
		});
	}
}

interface OwedContext {
	assistant: string;
	isPerson: (name: string) => boolean;
	backoff: (attempt: number) => number;
}

const ATTEMPT_REASONS: ReadonlySet<EndReason> = new Set(['failed', 'expired', 'refused']);

/**
 * The summaries still owed, one per person. A close owes one when the agents
 * said two or more things inside it, no summary covers it, and no draft stood
 * down over it. Every later close of the same person joins the draft: one
 * message reaches back to the earliest question still owed, and the latest
 * close names the draft.
 */
function foldOwed(
	closes: readonly CloseRow[],
	messages: readonly Message[],
	leases: ReadonlyMap<string, LeaseState>,
	context: OwedContext,
): Owed[] {
	const summaries = messages.filter(isSummary);
	const speaksForItself = (name: string) => !context.isPerson(name) && name !== context.assistant;
	const open = closes.filter(
		(close) => !summaries.some((s) => covers(s, close)) && !judged(leases, close.through),
	);
	const byPerson = new Map<string, Owed>();
	for (const close of open) {
		if (draftOver(messages, close.from, close.through, speaksForItself) === undefined) continue;
		const known = byPerson.get(close.owner);
		byPerson.set(close.owner, {
			person: close.owner,
			from: Math.min(known?.from ?? close.from, close.from),
			through: close.through,
			closes: [...(known?.closes ?? []), close.through],
			attempts: 0,
			notBefore: undefined,
		});
	}
	for (const close of open) joinLater(byPerson.get(close.owner), close);
	return [...byPerson.values()].map((owed) => withAttempts(owed, leases, context.backoff));
}

/** A later close of the same person joins the draft, whatever it held on its own. */
function joinLater(owed: Owed | undefined, close: CloseRow): void {
	if (owed === undefined || close.through <= owed.through) return;
	owed.through = close.through;
	owed.closes.push(close.through);
}

const covers = (summary: Message & { kind: 'summary' }, close: CloseRow): boolean =>
	summary.to === close.owner &&
	summary.covers.from <= close.from &&
	summary.covers.through >= close.through;

/** A draft over this close ended released without writing: the assistant judged the room. */
function judged(leases: ReadonlyMap<string, LeaseState>, through: Seq): boolean {
	for (const lease of leases.values()) {
		const parsed = parseId(lease.id);
		if (parsed?.kind !== 'draft' || parsed.through !== through) continue;
		if (lease.phase === 'ended' && lease.reason === 'released') return true;
	}
	return false;
}

/** How many drafts over these closes came to nothing, and when the next may start. */
function withAttempts(
	owed: Owed,
	leases: ReadonlyMap<string, LeaseState>,
	backoff: (attempt: number) => number,
): Owed {
	const failed = [...leases.values()].filter((lease) => cameToNothing(lease, owed.closes));
	const last = Math.max(0, ...failed.map((lease) => Date.parse(lease.at)));
	const attempts = failed.length;
	return { ...owed, attempts, notBefore: attempts === 0 ? undefined : last + backoff(attempts) };
}

/** A draft over one of these closes that ended failed, expired, or refused. */
function cameToNothing(lease: LeaseState, closes: readonly Seq[]): boolean {
	const parsed = parseId(lease.id);
	if (parsed?.kind !== 'draft' || !closes.includes(parsed.through)) return false;
	return lease.phase === 'ended' && lease.reason !== undefined && ATTEMPT_REASONS.has(lease.reason);
}
