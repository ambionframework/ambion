/**
 * Prototype: the exchange-fold rule group, in one file. The rules that exist
 * today in `packages/ambion/src/room/rules.verified.ts` and that the new
 * rules call (`beforeCancellation`, `survivesCancellation`, `coversExchange`)
 * are declared again here, verbatim, so the file verifies on its own.
 *
 * `Message` is the public union in `types.ts`. The stub below tells
 * LemmaScript the four fields the rules read; the runtime passes the real
 * messages, and the rules read nothing the stub does not name.
 */

import type { Message } from '../../../packages/ambion/src/types.ts';
//@ declare-type Message { kind: string, seq: number, from: string, at: string }

/** Why a lease ended. The same union as `EndReason` in `types.ts`. */
export type LeaseEndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** What wakes a seat. The same union as `Attention` in `types.ts`. */
export type SeatAttention = 'none' | 'named' | 'broadcast' | 'presence';

// ---- existing rules the new ones call -------------------------------------

//@ contract A cause before a cancellation marker belongs to cancelled work.
export function beforeCancellation(position: number, cancelledAt: number): boolean {
	//@ ensures \result <==> position < cancelledAt
	return position < cancelledAt;
}

//@ contract Work survives a cancellation when no marker stands, or its cause is at or after the marker.
export function survivesCancellation(position: number, cancelledAt: number | undefined): boolean {
	//@ ensures cancelledAt == undefined ==> \result
	//@ ensures cancelledAt != undefined ==> (\result <==> !beforeCancellation(position, cancelledAt))
	//@ ensures cancelledAt != undefined ==> (\result <==> position >= cancelledAt)
	if (cancelledAt === undefined) return true;
	return !beforeCancellation(position, cancelledAt);
}

//@ contract A summary covers a closed exchange when it addresses the owner and its range contains the exchange's range. A summary that covers a close stands for every position of the closed exchange.
export function coversExchange(
	summaryTo: string,
	summaryFrom: number,
	summaryThrough: number,
	owner: string,
	from: number,
	through: number,
): boolean {
	//@ ensures \result <==> (summaryTo == owner && summaryFrom <= from && summaryThrough >= through)
	//@ ensures \result ==> summaryTo == owner
	//@ ensures \result && from <= through ==> summaryFrom <= summaryThrough
	//@ ensures \result <==> (summaryTo == owner && coversClose(summaryFrom, summaryThrough, from, through))
	//@ ensures \result ==> forall(seq, from <= seq && seq <= through ==> coversSeq(summaryFrom, summaryThrough, seq))
	return summaryTo === owner && summaryFrom <= from && summaryThrough >= through;
}

// ---- covering-summary-stands-for-range ------------------------------------

//@ contract A summary stands for a position inside its covered range.
export function coversSeq(summaryFrom: number, summaryThrough: number, seq: number): boolean {
	//@ ensures \result <==> summaryFrom <= seq && seq <= summaryThrough
	return summaryFrom <= seq && seq <= summaryThrough;
}

//@ contract A summary that covers a close stands for every position of the closed exchange.
export function coversClose(
	summaryFrom: number,
	summaryThrough: number,
	closeFrom: number,
	closeThrough: number,
): boolean {
	//@ ensures \result <==> summaryFrom <= closeFrom && summaryThrough >= closeThrough
	//@ ensures \result ==> forall(seq, closeFrom <= seq && seq <= closeThrough ==> coversSeq(summaryFrom, summaryThrough, seq))
	return summaryFrom <= closeFrom && summaryThrough >= closeThrough;
}

// ---- summary-outcome-lattice ----------------------------------------------

/** A draft of one close's summary, as the outcome reads it: running, or ended with its reason and the cancellation marker. */
export type Draft =
	| { phase: 'running' }
	| { phase: 'ended'; reason: LeaseEndReason; cancelled: boolean };

/** The outcome of one close's summary work. A pending outcome is owed while the room still has to send a draft. */
export type Verdict =
	| { status: 'published' }
	| { status: 'pending'; owed: boolean }
	| { status: 'silent' }
	| { status: 'failed' };

//@ contract A draft stood down when one ended by release, revocation or abandonment.
function stoodDown(drafts: readonly Draft[]): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < drafts.length && drafts[i].phase == 'ended' && (drafts[i].reason == 'released' || drafts[i].reason == 'revoked' || drafts[i].reason == 'abandoned'))
	//@ ensures \result ==> drafts.length > 0
	return drafts.some(
		(draft) =>
			draft.phase === 'ended' &&
			(draft.reason === 'released' || draft.reason === 'revoked' || draft.reason === 'abandoned'),
	);
}

//@ contract A draft the writer released.
function draftReleased(drafts: readonly Draft[]): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < drafts.length && drafts[i].phase == 'ended' && drafts[i].reason == 'released')
	//@ ensures \result ==> stoodDown(drafts)
	return drafts.some((draft) => draft.phase === 'ended' && draft.reason === 'released');
}

//@ contract A draft still running.
function draftRunning(drafts: readonly Draft[]): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < drafts.length && drafts[i].phase == 'running')
	return drafts.some((draft) => draft.phase === 'running');
}

//@ contract A draft a cancellation after the close revoked.
function cancelledDraft(drafts: readonly Draft[], cancelledAfterClose: boolean): boolean {
	//@ ensures \result ==> cancelledAfterClose
	//@ ensures \result ==> stoodDown(drafts)
	//@ ensures \result <==> cancelledAfterClose && exists(i, 0 <= i && i < drafts.length && drafts[i].phase == 'ended' && drafts[i].reason == 'revoked' && drafts[i].cancelled)
	return (
		cancelledAfterClose &&
		drafts.some((draft) => draft.phase === 'ended' && draft.reason === 'revoked' && draft.cancelled)
	);
}

//@ contract The outcome of one close's summary work: a covering summary beats everything; no named writer is silent; a writer unseated after the close failed; a close owes a draft only while nothing stood down and no cancellation cut it.
export function summaryVerdict(
	covered: boolean,
	writerNamed: boolean,
	unseatedAfter: boolean,
	drafts: readonly Draft[],
	cancelledAfterClose: boolean,
): Verdict {
	//@ ensures covered ==> \result.status == 'published'
	//@ ensures \result.status == 'published' ==> covered
	//@ ensures !covered && !writerNamed ==> \result.status == 'silent'
	//@ ensures !covered && writerNamed && unseatedAfter ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !unseatedAfter && !stoodDown(drafts) && !cancelledAfterClose ==> \result.status == 'pending' && \result.owed
	//@ ensures !covered && writerNamed && !unseatedAfter && !stoodDown(drafts) && cancelledAfterClose ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !unseatedAfter && cancelledDraft(drafts, cancelledAfterClose) ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !unseatedAfter && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && draftRunning(drafts) ==> \result.status == 'pending' && !\result.owed
	//@ ensures !covered && writerNamed && !unseatedAfter && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && !draftRunning(drafts) && draftReleased(drafts) ==> \result.status == 'silent'
	//@ ensures !covered && writerNamed && !unseatedAfter && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && !draftRunning(drafts) && !draftReleased(drafts) ==> \result.status == 'failed'
	//@ ensures (\result.status == 'pending' && \result.owed) <==> (!covered && writerNamed && !unseatedAfter && !stoodDown(drafts) && !cancelledAfterClose)
	//@ ensures cancelledAfterClose && \result.status == 'pending' ==> !\result.owed
	//@ ensures \result.status == 'pending' && !\result.owed ==> drafts.length > 0
	if (covered) return { status: 'published' };
	if (!writerNamed) return { status: 'silent' };
	if (unseatedAfter) return { status: 'failed' };
	const down = stoodDown(drafts);
	if (cancelledDraft(drafts, cancelledAfterClose)) return { status: 'failed' };
	if (!down && cancelledAfterClose) return { status: 'failed' };
	if (!down) return { status: 'pending', owed: true };
	if (draftRunning(drafts)) return { status: 'pending', owed: false };
	if (draftReleased(drafts)) return { status: 'silent' };
	return { status: 'failed' };
}

// ---- cancel-lease-revokes-before-marker -----------------------------------

/** What the lease entries for one activation fold to, with the marker a cancellation projection leaves. */
export type LeaseHold =
	| {
			id: string;
			phase: 'running';
			/** When the last entry was written, ISO. */
			at: string;
			/** When the first entry was written, ISO. */
			claimedAt: string;
			/** The seq where this activation first attempted work. */
			since: number;
			/** The highest message position that the executor explicitly consumed. */
			readThrough: number;
			/** When a running lease expires, in milliseconds since the epoch. */
			expiresAt: number;
	  }
	| {
			id: string;
			phase: 'ended';
			at: string;
			claimedAt: string;
			since: number;
			readThrough: number;
			reason: LeaseEndReason;
			/** Derived marker for a lease ended by a cancellation projection. */
			cancelled?: true;
			/** The seq when the end landed. */
			until: number;
	  };

//@ contract A lease the cancellation projection ended carries the marker: it is ended and revoked.
export function markedCancelled(lease: LeaseHold): boolean {
	//@ ensures \result ==> lease.phase == 'ended'
	//@ ensures \result ==> lease.reason == 'revoked'
	return lease.phase === 'ended' && lease.reason === 'revoked' && lease.cancelled === true;
}

//@ contract A cancellation revokes a running lease whose cause sits before the marker, with the marker as its end and the marker's time, keeps its reads and its identity, and leaves every other lease as it was.
export function cancelLease(
	lease: LeaseHold,
	position: number,
	cancelledAt: number,
	at: string,
): LeaseHold {
	//@ ensures lease.phase == 'ended' ==> \result == lease
	//@ ensures lease.phase == 'running' && !beforeCancellation(position, cancelledAt) ==> \result == lease
	//@ ensures lease.phase == 'running' && beforeCancellation(position, cancelledAt) ==> \result.phase == 'ended' && \result.reason == 'revoked' && markedCancelled(\result) && \result.until == cancelledAt && \result.at == at
	//@ ensures \result.id == lease.id
	//@ ensures \result.readThrough == lease.readThrough
	//@ ensures \result.since == lease.since
	//@ ensures \result.claimedAt == lease.claimedAt
	//@ ensures lease.phase == 'ended' ==> \result.phase == 'ended'
	//@ ensures markedCancelled(\result) && !markedCancelled(lease) ==> lease.phase == 'running' && beforeCancellation(position, cancelledAt)
	if (lease.phase !== 'running' || !beforeCancellation(position, cancelledAt)) return lease;
	return {
		id: lease.id,
		phase: 'ended',
		at,
		claimedAt: lease.claimedAt,
		since: lease.since,
		readThrough: lease.readThrough,
		reason: 'revoked',
		cancelled: true,
		until: cancelledAt,
	};
}

// ---- last-seq-bounds-record -----------------------------------------------

//@ contract The last position on an ordered record bounds every position on it; an empty record ends at 0.
export function lastOf(seqs: readonly number[]): number {
	//@ requires forall(i, forall(j, 0 <= i && i < j && j < seqs.length ==> seqs[i] <= seqs[j]))
	//@ requires forall(i, 0 <= i && i < seqs.length ==> seqs[i] >= 1)
	//@ ensures \result >= 0
	//@ ensures seqs.length == 0 ==> \result == 0
	//@ ensures seqs.length > 0 ==> \result == seqs[seqs.length - 1]
	//@ ensures forall(i, 0 <= i && i < seqs.length ==> seqs[i] <= \result)
	return seqs[seqs.length - 1] ?? 0;
}

// ---- exchange-opens-first-question ----------------------------------------

//@ contract A message opens an exchange when a person spoke it after the last close: agent speech, arrivals and departures open nothing.
function opensExchange(message: Message, people: readonly string[], closedThrough: number): boolean {
	//@ ensures \result <==> message.kind == 'said' && people.includes(message.from) && message.seq > closedThrough
	//@ ensures message.kind != 'said' ==> !\result
	//@ ensures message.seq <= closedThrough ==> !\result
	return message.kind === 'said' && people.includes(message.from) && message.seq > closedThrough;
}

//@ contract The open exchange is the first message that opens one after the last close; there is at most one, and its position is on the record.
export function openingQuestion(
	messages: readonly Message[],
	people: readonly string[],
	closedThrough: number,
): Message | undefined {
	//@ requires forall(i, forall(j, 0 <= i && i < j && j < messages.length ==> messages[i].seq < messages[j].seq))
	//@ ensures \result != undefined ==> \result.kind == 'said' && people.includes(\result.from) && \result.seq > closedThrough
	//@ ensures \result == undefined <==> !exists(i, 0 <= i && i < messages.length && opensExchange(messages[i], people, closedThrough))
	//@ ensures \result != undefined ==> exists(i, 0 <= i && i < messages.length && messages[i] == \result && forall(j, 0 <= j && j < i ==> !opensExchange(messages[j], people, closedThrough)))
	//@ ensures \result != undefined ==> messages.length > 0 && \result.seq <= messages[messages.length - 1].seq
	return messages.find((message) => opensExchange(message, people, closedThrough));
}

// ---- discussion-range-excludes-summaries ----------------------------------

//@ contract The discussion of an exchange: every non-summary message inside the inclusive range, in record order, and nothing else.
export function discussion(messages: readonly Message[], from: number, through: number): Message[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].kind != 'summary' && from <= \result[i].seq && \result[i].seq <= through)
	//@ ensures forall(k, 0 <= k && k < messages.length && messages[k].kind != 'summary' && from <= messages[k].seq && messages[k].seq <= through ==> exists(i, 0 <= i && i < \result.length && \result[i] == messages[k]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> messages.includes(\result[i]))
	//@ ensures \result.length <= messages.length
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		//@ invariant 0 <= i && i <= messages.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].kind != 'summary' && from <= out[m].seq && out[m].seq <= through)
		//@ invariant forall(k, 0 <= k && k < i && messages[k].kind != 'summary' && from <= messages[k].seq && messages[k].seq <= through ==> exists(m, 0 <= m && m < out.length && out[m] == messages[k]))
		//@ invariant forall(m, 0 <= m && m < out.length ==> messages.includes(out[m]))
		const head = messages[i] ?? {
			kind: 'summary',
			seq: 0,
			at: '',
			from: '',
			to: '',
			text: '',
			covers: { from: 0, through: 0 },
		};
		if (head.kind !== 'summary' && head.seq >= from && head.seq <= through) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

// ---- messages-since-cursor ------------------------------------------------

//@ contract A read after a cursor returns exactly the messages past it, and keeps record order when the record is in order.
export function messagesSince(messages: readonly Message[], since: number): Message[] {
	//@ requires forall(a, forall(b, 0 <= a && a < b && b < messages.length ==> messages[a].seq < messages[b].seq))
	//@ ensures \result.length <= messages.length
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].seq > since)
	//@ ensures forall(i, 0 <= i && i < \result.length ==> messages.includes(\result[i]))
	//@ ensures forall(k, 0 <= k && k < messages.length && messages[k].seq > since ==> \result.includes(messages[k]))
	//@ ensures forall(a, forall(b, 0 <= a && a < b && b < \result.length ==> \result[a].seq < \result[b].seq))
	const out: Message[] = [];
	for (let i = 0; i < messages.length; i++) {
		//@ invariant 0 <= i && i <= messages.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].seq > since)
		//@ invariant forall(m, 0 <= m && m < out.length ==> messages.includes(out[m]))
		//@ invariant forall(k, 0 <= k && k < i && messages[k].seq > since ==> out.includes(messages[k]))
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < out.length ==> out[a].seq < out[b].seq))
		//@ invariant forall(m, 0 <= m && m < out.length ==> forall(k, i <= k && k < messages.length ==> out[m].seq < messages[k].seq))
		const head = messages[i] ?? { kind: 'said', seq: since, at: '', from: '', text: '' };
		if (head.seq > since) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

// ---- exchange-containing-question -----------------------------------------

/** The range a close holds: the opening question through the last seq at the close. */
export interface Range {
	readonly from: number;
	readonly through: number;
}

/** The exchange a committed question belongs to. */
export type Found = { kind: 'closed'; from: number } | { kind: 'open'; from: number } | { kind: 'outside' };

//@ contract A position is inside a closed range when it lies between its ends.
function inside(range: Range, seq: number): boolean {
	//@ ensures \result <==> (range.from <= seq && seq <= range.through)
	return range.from <= seq && seq <= range.through;
}

//@ contract The exchange a question belongs to: the first close whose range holds it, else the open exchange when the question is at or after its opening, else none.
export function exchangeContaining(closes: readonly Range[], open: number | undefined, seq: number): Found {
	//@ ensures \result.kind == 'closed' ==> exists(i, 0 <= i && i < closes.length && inside(closes[i], seq) && closes[i].from == \result.from && forall(k, 0 <= k && k < i ==> !inside(closes[k], seq)))
	//@ ensures \result.kind != 'closed' ==> forall(i, 0 <= i && i < closes.length ==> !inside(closes[i], seq))
	//@ ensures open == undefined ==> \result.kind != 'open'
	//@ ensures open != undefined && \result.kind == 'open' ==> open == \result.from && \result.from <= seq
	//@ ensures open == undefined && \result.kind != 'closed' ==> \result.kind == 'outside'
	//@ ensures open != undefined && \result.kind == 'outside' ==> open > seq
	//@ ensures open != undefined && open <= seq ==> \result.kind != 'outside'
	//@ ensures \result.kind == 'closed' || \result.kind == 'open' ==> \result.from <= seq
	for (let i = 0; i < closes.length; i++) {
		//@ invariant 0 <= i && i <= closes.length
		//@ invariant forall(k, 0 <= k && k < i ==> !inside(closes[k], seq))
		const close = closes[i] ?? { from: 0, through: -1 };
		if (inside(close, seq)) return { kind: 'closed', from: close.from };
	}
	if (open !== undefined && open <= seq) return { kind: 'open', from: open };
	return { kind: 'outside' };
}

// ---- reserve-disjoint-covers-catalog --------------------------------------

/** One seat as the roster and the reserve list it. The same shape as `Seating` in `events.ts`. */
export interface Seat {
	readonly name: string;
	readonly identity: string;
	readonly attention: SeatAttention;
}

//@ contract A name is on the roster when a seat carries it.
function carries(roster: readonly Seat[], name: string): boolean {
	//@ ensures \result <==> exists(k, 0 <= k && k < roster.length && roster[k].name == name)
	return roster.some((seat) => seat.name === name);
}

//@ contract A seat comes from the catalog when a catalog seat has its name and identity.
function fromCatalog(catalog: readonly Seat[], seat: Seat): boolean {
	//@ ensures \result <==> exists(k, 0 <= k && k < catalog.length && catalog[k].name == seat.name && catalog[k].identity == seat.identity)
	return catalog.some((held) => held.name === seat.name && held.identity === seat.identity);
}

//@ contract A catalog seat as the reserve lists it: the same name and identity, at broadcast attention.
function atBroadcast(seat: Seat): Seat {
	//@ ensures \result.name == seat.name
	//@ ensures \result.identity == seat.identity
	//@ ensures \result.attention == 'broadcast'
	return { name: seat.name, identity: seat.identity, attention: 'broadcast' };
}

//@ contract The reserve holds every catalog seat whose name is not on the roster, with its catalog identity at broadcast attention: the reserve and the roster are disjoint, every reserve seat comes from the catalog, and every catalog name is on one of them.
export function reserveOf(catalog: readonly Seat[], roster: readonly Seat[]): Seat[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !carries(roster, \result[i].name))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].attention == 'broadcast')
	//@ ensures forall(i, 0 <= i && i < \result.length ==> fromCatalog(catalog, \result[i]))
	//@ ensures forall(k, 0 <= k && k < catalog.length ==> carries(roster, catalog[k].name) || exists(i, 0 <= i && i < \result.length && \result[i].name == catalog[k].name && \result[i].identity == catalog[k].identity))
	//@ ensures \result.length <= catalog.length
	const out: Seat[] = [];
	for (let i = 0; i < catalog.length; i++) {
		//@ invariant 0 <= i && i <= catalog.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> !carries(roster, out[m].name))
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].attention == 'broadcast')
		//@ invariant forall(m, 0 <= m && m < out.length ==> fromCatalog(catalog, out[m]))
		//@ invariant forall(k, 0 <= k && k < i ==> carries(roster, catalog[k].name) || exists(m, 0 <= m && m < out.length && out[m].name == catalog[k].name && out[m].identity == catalog[k].identity))
		const head = catalog[i] ?? { name: '', identity: '', attention: 'broadcast' };
		if (!carries(roster, head.name)) {
			//@ ghost let before = out
			out.push(atBroadcast(head));
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length].name == head.name && out[before.length].identity == head.identity
		}
	}
	return out;
}

// ---- reseat-once-per-name -------------------------------------------------

/** What one message does to the roster: a seating, an unseating, or nothing. */
export type Membership =
	| { kind: 'seated'; name: string; identity: string; attention: SeatAttention }
	| { kind: 'unseated'; name: string }
	| { kind: 'other' };

//@ contract Every seat but the named one, in record order: nothing with the name remains, every other seat stays, nothing else appears, and one seat per name is kept.
function without(roster: readonly Seat[], name: string): Seat[] {
	//@ ensures forall(i, 0 <= i && i < \result.length ==> \result[i].name != name)
	//@ ensures forall(i, 0 <= i && i < \result.length ==> roster.includes(\result[i]))
	//@ ensures forall(k, 0 <= k && k < roster.length && roster[k].name != name ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[k]))
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < roster.length ==> roster[i].name != roster[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	//@ ensures \result.length <= roster.length
	const out: Seat[] = [];
	for (let i = 0; i < roster.length; i++) {
		//@ invariant 0 <= i && i <= roster.length
		//@ invariant out.length <= i
		//@ invariant forall(m, 0 <= m && m < out.length ==> out[m].name != name)
		//@ invariant forall(m, 0 <= m && m < out.length ==> exists(k, 0 <= k && k < i && roster[k] == out[m]))
		//@ invariant forall(m, 0 <= m && m < out.length ==> roster.includes(out[m]))
		//@ invariant forall(k, 0 <= k && k < i && roster[k].name != name ==> exists(m, 0 <= m && m < out.length && out[m] == roster[k]))
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < roster.length ==> roster[a].name != roster[b].name)) ==> forall(m, forall(n, 0 <= m && m < n && n < out.length ==> out[m].name != out[n].name))
		const head = roster[i] ?? { name: '', identity: '', attention: 'broadcast' };
		if (head.name !== name) {
			//@ ghost let before = out
			out.push(head);
			//@ assert forall(m, 0 <= m && m < before.length ==> out[m] == before[m])
			//@ assert out[before.length] == head
		}
	}
	return out;
}

//@ contract One seating or unseating applied to the roster; any other message changes nothing. A seated name is on the roster once, at the end, with the message's identity and attention; an unseated name is gone; every other seat stays; nothing else appears; one seat per name is kept.
export function reseated(roster: readonly Seat[], change: Membership): Seat[] {
	//@ ensures change.kind == 'other' ==> \result == roster
	//@ ensures change.kind == 'unseated' ==> !carries(\result, change.name)
	//@ ensures change.kind == 'seated' ==> \result.length >= 1 && \result[\result.length - 1].name == change.name && \result[\result.length - 1].identity == change.identity && \result[\result.length - 1].attention == change.attention
	//@ ensures change.kind == 'seated' ==> forall(i, 0 <= i && i < \result.length - 1 ==> \result[i].name != change.name)
	//@ ensures change.kind != 'other' ==> forall(i, 0 <= i && i < \result.length && \result[i].name != change.name ==> roster.includes(\result[i]))
	//@ ensures change.kind != 'other' ==> forall(k, 0 <= k && k < roster.length && roster[k].name != change.name ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[k]))
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < roster.length ==> roster[i].name != roster[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	if (change.kind === 'other') return [...roster];
	const rest = without(roster, change.name);
	if (change.kind === 'unseated') return rest;
	const seat = { name: change.name, identity: change.identity, attention: change.attention };
	const out = [...rest, seat];
	//@ assert forall(m, 0 <= m && m < rest.length ==> out[m] == rest[m])
	//@ assert out[rest.length] == seat
	return out;
}

// ---- roster-fold-after-composition ----------------------------------------

/** One message's place on the record and what it does to the roster. */
export interface RosterChange {
	readonly seq: number;
	readonly membership: Membership;
}

//@ contract A change sits after the composition when its position is past it.
function afterComposition(seq: number, compositionSeq: number): boolean {
	//@ ensures \result <==> seq > compositionSeq
	return seq > compositionSeq;
}

//@ contract The roster is the composition's agents, then every membership change after the composition applied in order; a change at or before the composition changes nothing, and a change that is not a membership change changes nothing.
export function foldRoster(
	agents: readonly Seat[],
	changes: readonly RosterChange[],
	compositionSeq: number,
): Seat[] {
	//@ ensures forall(i, 0 <= i && i < changes.length ==> !afterComposition(changes[i].seq, compositionSeq) || changes[i].membership.kind == 'other') ==> \result == agents
	//@ ensures forall(i, forall(j, 0 <= i && i < j && j < agents.length ==> agents[i].name != agents[j].name)) ==> forall(i, forall(j, 0 <= i && i < j && j < \result.length ==> \result[i].name != \result[j].name))
	let roster: Seat[] = [...agents];
	for (let i = 0; i < changes.length; i++) {
		//@ invariant 0 <= i && i <= changes.length
		//@ invariant forall(k, 0 <= k && k < i ==> !afterComposition(changes[k].seq, compositionSeq) || changes[k].membership.kind == 'other') ==> roster == agents
		//@ invariant forall(a, forall(b, 0 <= a && a < b && b < agents.length ==> agents[a].name != agents[b].name)) ==> forall(m, forall(n, 0 <= m && m < n && n < roster.length ==> roster[m].name != roster[n].name))
		const change = changes[i] ?? { seq: 0, membership: { kind: 'other' } };
		if (afterComposition(change.seq, compositionSeq)) roster = reseated(roster, change.membership);
	}
	return roster;
}
