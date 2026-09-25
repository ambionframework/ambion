/**
 * The rules the room decides by, as functions LemmaScript checks: the
 * activation lifecycle and the exchange lifecycle. Every function here is
 * pure, and `lease.ts`, `reconcile.ts`, `transition.ts`, `activation.ts`,
 * `exchange.ts`, and `fold.ts` run these bodies: the proof is about the
 * code the room runs. A rule is here when its contract states a property
 * the body does not restate, or when a proof depends on it. `lsc check`
 * turns the `//@` annotations into Dafny obligations, and CI verifies
 * them. `rules.verified.proofs.dfy` beside this file carries the lemmas
 * the generator cannot write.
 *
 * The string unions below are declared again beside the rules, because
 * LemmaScript lowers only the types in its own file. `rules.test.ts`
 * asserts each copy equals the public type in `types.ts`. `Message` is
 * the public union itself; the stub names the five fields the rules read.
 */

import type { Message } from '../types.ts';
//@ declare-type Message { kind: string, seq: number, from: string, owner: string, at: string }

/** The two phases a lease holds. */
export type LeasePhase = 'running' | 'ended';

/** Why a lease ended. The same union as `EndReason` in `types.ts`. */
export type LeaseEndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** Why an activation failed. The same union as `FailureCause` in `types.ts`. */
export type FailureCause = 'permanent' | 'transient';

//@ contract A lease is past its expiry once now reaches it.
function expired(expiry: number, now: number): boolean {
	//@ ensures \result <==> expiry <= now
	return expiry <= now;
}

//@ contract A lease covers an entry while it attempts work, and every earlier entry with it.
export function coversAttempt(ended: boolean, until: number, seq: number): boolean {
	//@ ensures !ended ==> \result
	//@ ensures ended ==> (\result <==> seq <= until)
	//@ ensures \result ==> forall(earlier, earlier <= seq ==> coversAttempt(ended, until, earlier))
	return !ended || seq <= until;
}

//@ contract The next attempt is numbered after the failed ones.
function nextAttempt(attempts: number): number {
	//@ requires attempts >= 0
	//@ ensures \result == attempts + 1
	//@ ensures \result >= 1
	return attempts + 1;
}

//@ contract A cause before a cancellation marker belongs to cancelled work.
function beforeCancellation(position: number, cancelledAt: number): boolean {
	//@ ensures \result <==> position < cancelledAt
	return position < cancelledAt;
}

//@ contract Ended is final. An activation that never claimed ends only by revocation or abandonment. A running lease is revoked at will, ends as expired only past its expiry, and as released or failed only before it.
export function mayEnd(
	known: LeasePhase | undefined,
	reason: LeaseEndReason,
	pastExpiry: boolean,
): boolean {
	//@ ensures known == undefined ==> (\result <==> (reason == 'revoked' || reason == 'abandoned'))
	//@ ensures known != undefined && known == 'ended' ==> !\result
	//@ ensures known != undefined && known == 'running' && reason == 'abandoned' ==> !\result
	//@ ensures known != undefined && known == 'running' && reason == 'revoked' ==> \result
	//@ ensures known != undefined && known == 'running' && reason == 'expired' ==> (\result <==> pastExpiry)
	//@ ensures known != undefined && known == 'running' && reason == 'released' ==> (\result <==> !pastExpiry)
	//@ ensures known != undefined && known == 'running' && reason == 'failed' ==> (\result <==> !pastExpiry)
	if (known === undefined) return reason === 'revoked' || reason === 'abandoned';
	if (known === 'ended' || reason === 'abandoned') return false;
	if (reason === 'revoked') return true;
	return pastExpiry === (reason === 'expired');
}

//@ contract A claim or a renewal expires at the earlier of now plus the expiry and the first claim plus the deadline. A fresh claim expires after now, and a renewal expires after now exactly when the deadline has not passed.
export function leaseExpiry(
	now: number,
	claimedAt: number,
	expiry: number,
	deadline: number,
): number {
	//@ requires expiry >= 1
	//@ requires deadline >= 1
	//@ ensures \result <= now + expiry
	//@ ensures \result <= claimedAt + deadline
	//@ ensures \result == now + expiry || \result == claimedAt + deadline
	//@ ensures \result > now <==> claimedAt + deadline > now
	//@ ensures claimedAt == now ==> \result > now
	//@ ensures !expired(\result, now) <==> !expired(claimedAt + deadline, now)
	return Math.min(now + expiry, claimedAt + deadline);
}

//@ contract The acknowledged position never moves back: a claim, and a renewal that states nothing, keep the prior acknowledgment.
export function acknowledged(prior: number | undefined, incoming: number): number {
	//@ requires incoming >= 0
	//@ requires prior != undefined ==> prior >= 0
	//@ ensures prior != undefined ==> \result >= prior
	//@ ensures \result >= incoming
	//@ ensures prior == undefined ==> \result == incoming
	//@ ensures prior != undefined ==> (\result == prior || \result == incoming)
	//@ ensures prior != undefined && incoming == 0 ==> \result == prior
	//@ ensures \result >= 0
	return prior === undefined ? incoming : Math.max(prior, incoming);
}

/** What a spoken commit's read position says: off the record, short of it, or at its end. */
export type Freshness = 'invalid' | 'missed' | 'fresh';

//@ contract A position is on the record when it is between zero and the last seq.
export function onRecord(position: number, lastSeq: number): boolean {
	//@ requires lastSeq >= 0
	//@ ensures \result <==> (0 <= position && position <= lastSeq)
	return position >= 0 && position <= lastSeq;
}

//@ contract The say lock: a spoken commit lands only at the record's last seq. A position short of it is missed, and one off the record is invalid.
export function speechFreshness(readThrough: number | undefined, lastSeq: number): Freshness {
	//@ requires lastSeq >= 0
	//@ ensures readThrough == undefined ==> \result == 'invalid'
	//@ ensures readThrough != undefined ==> (\result == 'invalid' <==> !onRecord(readThrough, lastSeq))
	//@ ensures readThrough != undefined ==> (\result == 'fresh' <==> readThrough == lastSeq)
	//@ ensures readThrough != undefined ==> (\result == 'missed' <==> (0 <= readThrough && readThrough < lastSeq))
	//@ ensures \result == 'missed' ==> lastSeq > 0
	if (readThrough === undefined || !onRecord(readThrough, lastSeq)) return 'invalid';
	return readThrough < lastSeq ? 'missed' : 'fresh';
}

/** The open exchange, as the close admission reads it. */
export interface OpenExchange {
	readonly owner: string;
	readonly from: number;
}

/** A close, as the close admission reads it. */
export interface CloseRef {
	readonly owner: string;
	readonly from: number;
	readonly through: number;
}

//@ contract A close is written only for the open exchange, at the record's last seq, with nothing of the exchange's work live.
export function admitsClose(
	open: OpenExchange | undefined,
	close: CloseRef,
	lastSeq: number,
	exchangeLive: boolean,
): boolean {
	//@ ensures \result ==> open != undefined
	//@ ensures open != undefined ==> (\result <==> (open.from == close.from && open.owner == close.owner && close.through == lastSeq && !exchangeLive))
	//@ ensures exchangeLive ==> !\result
	//@ ensures \result ==> close.through == lastSeq
	if (open === undefined) return false;
	return (
		open.from === close.from &&
		open.owner === close.owner &&
		close.through === lastSeq &&
		!exchangeLive
	);
}

//@ contract A summary covers a close when its range contains the close's range.
function coversClose(
	summaryFrom: number,
	summaryThrough: number,
	closeFrom: number,
	closeThrough: number,
): boolean {
	//@ ensures \result <==> summaryFrom <= closeFrom && summaryThrough >= closeThrough
	return summaryFrom <= closeFrom && summaryThrough >= closeThrough;
}

//@ contract A summary covers a closed exchange when it addresses the owner and its range contains the exchange's range.
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
	return summaryTo === owner && coversClose(summaryFrom, summaryThrough, from, through);
}

//@ contract Work survives a cancellation when no marker stands, or its cause is at or after the marker.
export function survivesCancellation(position: number, cancelledAt: number | undefined): boolean {
	//@ ensures cancelledAt == undefined ==> \result
	//@ ensures cancelledAt != undefined ==> (\result <==> !beforeCancellation(position, cancelledAt))
	//@ ensures cancelledAt != undefined ==> (\result <==> position >= cancelledAt)
	if (cancelledAt === undefined) return true;
	return !beforeCancellation(position, cancelledAt);
}

/** The lease the fold holds for one id. `LeaseHold` in `lease.ts` is this type. */
export type Hold =
	| {
			id: string;
			phase: 'running';
			at: string;
			claimedAt: string;
			since: number;
			readThrough: number;
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
			/** The marker of a lease a cancellation ended. */
			cancelled?: true;
			/** Why the activation failed, on a failed or abandoned lease. */
			cause?: FailureCause;
			until: number;
	  };

/** One lease entry, as the journal records it. The same shape as `LeaseChange` in `events.ts`. */
export type Change =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: number }
	| {
			id: string;
			phase: 'ended';
			reason: LeaseEndReason;
			at: string;
			readThrough: number;
			cause?: FailureCause;
	  };

/** A lease that covers a message, as the wake rules read it: its phase, reason, acknowledgment, and the position its id names. */
export type Taken =
	| { phase: 'running'; readThrough: number; position: number }
	| { phase: 'ended'; reason: LeaseEndReason; readThrough: number; position: number };

//@ contract One lease entry applied to the lease the fold holds. An ended lease is final. The first entry fixes since and claimedAt. readThrough never moves back. An ending entry sets until to its own seq and carries its reason.
export function applyChange(known: Hold | undefined, change: Change, seq: number): Hold {
	//@ requires seq >= 1
	//@ requires change.readThrough >= 0
	//@ requires known != undefined ==> known.readThrough >= 0 && known.since <= seq
	//@ ensures known != undefined && known.phase == 'ended' ==> \result == known
	//@ ensures known == undefined ==> \result.since == seq && \result.claimedAt == change.at
	//@ ensures known != undefined ==> \result.since == known.since && \result.claimedAt == known.claimedAt
	//@ ensures known != undefined ==> \result.readThrough >= known.readThrough
	//@ ensures known == undefined ==> \result.readThrough == change.readThrough
	//@ ensures known != undefined && known.phase == 'running' ==> \result.readThrough >= change.readThrough
	//@ ensures known == undefined ==> \result.id == change.id && \result.at == change.at
	//@ ensures known != undefined && known.phase == 'running' ==> \result.id == change.id && \result.at == change.at
	//@ ensures known == undefined && change.phase == 'ended' ==> \result.phase == 'ended' && \result.until == seq && \result.reason == change.reason && \result.cause == change.cause
	//@ ensures known != undefined && known.phase == 'running' && change.phase == 'ended' ==> \result.phase == 'ended' && \result.until == seq && \result.reason == change.reason && \result.cause == change.cause
	//@ ensures known == undefined && change.phase == 'running' ==> \result.phase == 'running' && \result.expiresAt == change.expiresAt
	//@ ensures known != undefined && known.phase == 'running' && change.phase == 'running' ==> \result.phase == 'running' && \result.expiresAt == change.expiresAt
	//@ ensures known == undefined && \result.phase == 'ended' ==> \result.since <= \result.until
	//@ ensures known != undefined && known.phase == 'running' && \result.phase == 'ended' ==> \result.since <= \result.until
	if (known !== undefined && known.phase === 'ended') return known;
	const since = known === undefined ? seq : known.since;
	const claimedAt = known === undefined ? change.at : known.claimedAt;
	const prior = known === undefined ? 0 : known.readThrough;
	const readThrough = Math.max(prior, change.readThrough);
	if (change.phase === 'running') {
		return {
			id: change.id,
			phase: 'running',
			at: change.at,
			claimedAt,
			since,
			readThrough,
			expiresAt: change.expiresAt,
		};
	}
	return {
		id: change.id,
		phase: 'ended',
		at: change.at,
		claimedAt,
		since,
		readThrough,
		reason: change.reason,
		cause: change.cause,
		until: seq,
	};
}

//@ contract A lease the cancellation projection ended carries the marker: it is ended and revoked.
// biome-ignore lint/correctness/noUnusedVariables: the contract of `cancelHold` names it, and Dafny reads it there.
function markedCancelled(hold: Hold): boolean {
	//@ ensures \result ==> hold.phase == 'ended'
	//@ ensures \result ==> hold.reason == 'revoked'
	return hold.phase === 'ended' && hold.reason === 'revoked' && hold.cancelled === true;
}

//@ contract A cancellation marker ends every running lease whose cause is before it as revoked and marked, at the marker's seq, and keeps its id, since, claimedAt and readThrough. An ended lease, and a running lease caused at or after the marker, stay as they are.
export function cancelHold(hold: Hold, position: number, cancelledAt: number, at: string): Hold {
	//@ requires hold.since <= cancelledAt
	//@ ensures hold.phase == 'ended' ==> \result == hold
	//@ ensures hold.phase == 'running' && !beforeCancellation(position, cancelledAt) ==> \result == hold
	//@ ensures hold.phase == 'running' && beforeCancellation(position, cancelledAt) ==> \result.phase == 'ended' && \result.reason == 'revoked' && markedCancelled(\result) && \result.until == cancelledAt && \result.at == at
	//@ ensures \result.readThrough == hold.readThrough
	//@ ensures \result.since == hold.since
	//@ ensures \result.claimedAt == hold.claimedAt
	//@ ensures \result.id == hold.id
	//@ ensures \result.phase == 'ended' && hold.phase == 'running' ==> \result.since <= \result.until
	//@ ensures markedCancelled(\result) && !markedCancelled(hold) ==> hold.phase == 'running' && beforeCancellation(position, cancelledAt)
	if (hold.phase === 'ended' || !beforeCancellation(position, cancelledAt)) return hold;
	return {
		id: hold.id,
		phase: 'ended',
		at,
		claimedAt: hold.claimedAt,
		since: hold.since,
		readThrough: hold.readThrough,
		reason: 'revoked',
		cancelled: true,
		until: cancelledAt,
	};
}

//@ contract A lease is expired when it runs and now reached its expiry.
export function isExpired(phase: LeasePhase, expiresAt: number, now: number): boolean {
	//@ ensures \result <==> (phase == 'running' && expired(expiresAt, now))
	//@ ensures \result ==> phase == 'running'
	return phase === 'running' && expired(expiresAt, now);
}

//@ contract A lease is live when it runs and now is before its expiry. A running lease is live or expired and never both; an ended lease is neither.
export function isLive(phase: LeasePhase, expiresAt: number, now: number): boolean {
	//@ ensures \result <==> (phase == 'running' && now < expiresAt)
	//@ ensures !(\result && isExpired(phase, expiresAt, now))
	//@ ensures phase == 'running' ==> (\result || isExpired(phase, expiresAt, now))
	//@ ensures phase == 'ended' ==> !\result
	return phase === 'running' && !isExpired(phase, expiresAt, now);
}

//@ contract An attempt came to nothing when it failed or expired.
function cameToNothing(reason: LeaseEndReason): boolean {
	//@ ensures \result <==> (reason == 'failed' || reason == 'expired')
	return reason === 'failed' || reason === 'expired';
}

//@ contract A running lease answers every message it covers. A failed or expired lease answers nothing. An abandoned or revoked lease answers the position its id names. Every other ended lease answers only positions at or below its acknowledged readThrough.
function answers(lease: Taken, seq: number): boolean {
	//@ requires seq >= 1
	//@ ensures lease.phase == 'running' ==> \result
	//@ ensures lease.phase == 'ended' && cameToNothing(lease.reason) ==> !\result
	//@ ensures lease.phase == 'ended' && lease.reason == 'released' ==> (\result <==> lease.readThrough >= seq)
	//@ ensures lease.phase == 'ended' && (lease.reason == 'abandoned' || lease.reason == 'revoked') ==> (\result <==> (lease.position == seq || lease.readThrough >= seq))
	//@ ensures lease.phase == 'ended' && lease.readThrough < seq && lease.position != seq ==> !\result
	if (lease.phase === 'running') return true;
	if (cameToNothing(lease.reason)) return false;
	if ((lease.reason === 'abandoned' || lease.reason === 'revoked') && lease.position === seq)
		return true;
	return lease.readThrough >= seq;
}

//@ contract A wake is answered when some covering lease answers it. A pending wake has no running covering lease, and no covering lease acknowledged the message.
export function wakeAnswered(taken: Taken[], seq: number): boolean {
	//@ requires seq >= 1
	//@ ensures \result <==> exists(i, 0 <= i && i < taken.length && answers(taken[i], seq))
	//@ ensures !\result ==> forall(i, 0 <= i && i < taken.length ==> taken[i].phase == 'ended')
	//@ ensures !\result ==> forall(i, 0 <= i && i < taken.length ==> taken[i].phase == 'ended' && (cameToNothing(taken[i].reason) || taken[i].readThrough < seq))
	return taken.some((lease) => answers(lease, seq));
}

//@ contract A covering lease counts as an unsuccessful attempt when it came to nothing, or when it ended for any reason and its id names the message. A running lease never counts.
export function countsAgainst(lease: Taken, seq: number): boolean {
	//@ requires seq >= 1
	//@ ensures lease.phase == 'running' ==> !\result
	//@ ensures lease.phase == 'ended' && cameToNothing(lease.reason) ==> \result
	//@ ensures lease.phase == 'ended' && !cameToNothing(lease.reason) ==> (\result <==> lease.position == seq)
	if (lease.phase === 'running') return false;
	return cameToNothing(lease.reason) || lease.position === seq;
}

/** How a running lease ends in a pass, or that it stays. */
export type Ending = 'revoked' | 'expired' | 'stays';

/** The journal fact that caused an activation. The same union as `ActivationSource`. */
export type Source = 'message' | 'closed';

//@ contract A running lease is revoked when its seat is stale; else it is expired when past its expiry; else it stays. A revocation wins over an expiry, and an ended lease is never ended again.
export function endingOf(running: boolean, stale: boolean, pastExpiry: boolean): Ending {
	//@ ensures !running ==> \result == 'stays'
	//@ ensures running && stale ==> \result == 'revoked'
	//@ ensures running && !stale && pastExpiry ==> \result == 'expired'
	//@ ensures running && !stale && !pastExpiry ==> \result == 'stays'
	//@ ensures \result == 'expired' ==> !stale
	//@ ensures \result != 'stays' ==> running
	if (!running) return 'stays';
	if (stale) return 'revoked';
	return pastExpiry ? 'expired' : 'stays';
}

/** How a closed exchange ended. The same tags as `ExchangeOutcome` in `types.ts`. */
export type OutcomeKind = 'complete' | 'cancelled' | 'exhausted' | 'awaiting';

//@ contract A closed exchange reads cancelled before exhausted, exhausted before awaiting, and awaiting before complete. Each outcome needs its own fact, and complete needs none.
export function exchangeOutcome(
	cancelled: boolean,
	exhausted: boolean,
	awaiting: boolean,
): OutcomeKind {
	//@ ensures cancelled ==> \result == 'cancelled'
	//@ ensures !cancelled && exhausted ==> \result == 'exhausted'
	//@ ensures !cancelled && !exhausted && awaiting ==> \result == 'awaiting'
	//@ ensures !cancelled && !exhausted && !awaiting ==> \result == 'complete'
	//@ ensures \result == 'cancelled' ==> cancelled
	//@ ensures \result == 'exhausted' ==> !cancelled && exhausted
	//@ ensures \result == 'awaiting' ==> !cancelled && !exhausted && awaiting
	if (cancelled) return 'cancelled';
	if (exhausted) return 'exhausted';
	return awaiting ? 'awaiting' : 'complete';
}

/** A lease as the liveness rules read it. */
export interface LiveLease {
	readonly source: Source;
	readonly seat: string;
	readonly phase: LeasePhase;
	readonly expiresAt: number;
}

/** An activation the room owes, as the liveness rules read it. */
export interface OwedActivation {
	readonly source: Source;
	readonly seat: string;
}

//@ contract An activation holds an exchange open when a message caused it. A close causes none that does.
function holdsExchange(source: Source): boolean {
	//@ ensures \result <==> source == 'message'
	return source === 'message';
}

//@ contract The exchange's own work is live when a live lease a message caused exists, or the room owes an activation a message caused: through its backoff, and at the cap until the abandonment lands.
export function exchangeLive(
	leases: readonly LiveLease[],
	due: readonly OwedActivation[],
	now: number,
): boolean {
	//@ ensures \result <==> (exists(i, 0 <= i && i < leases.length && isLive(leases[i].phase, leases[i].expiresAt, now) && holdsExchange(leases[i].source)) || exists(j, 0 <= j && j < due.length && holdsExchange(due[j].source)))
	//@ ensures forall(i, 0 <= i && i < leases.length ==> leases[i].source == 'closed') && forall(j, 0 <= j && j < due.length ==> due[j].source == 'closed') ==> !\result
	//@ ensures exists(j, 0 <= j && j < due.length && due[j].source == 'message') ==> \result
	//@ ensures forall(i, 0 <= i && i < leases.length ==> !isLive(leases[i].phase, leases[i].expiresAt, now)) && due.length == 0 ==> !\result
	//@ ensures leases.length == 0 && due.length == 0 ==> !\result
	return (
		leases.some(
			(lease) => isLive(lease.phase, lease.expiresAt, now) && holdsExchange(lease.source),
		) || due.some((owed) => holdsExchange(owed.source))
	);
}

/** The fields an activation id encodes. The same shape as `ActivationId` in `activation-id.ts`. */
export interface ActivationFields {
	readonly source: Source;
	readonly position: number;
	readonly seat: string;
	readonly attempt: number;
}

/** A close, as the closing grant reads it. `Close` in `events.ts` passes as this. */
export interface CloseFact {
	readonly owner: string;
	readonly from: number;
	readonly through: number;
	readonly summary?: string;
}

/** What an activation is for. The same shape as `ActivationPurpose` in `protocol.ts`. */
export type GrantPurpose =
	| { readonly kind: 'respond'; readonly message: number }
	| {
			readonly kind: 'summarize';
			readonly exchange: number;
			readonly person: string;
			readonly through: number;
	  };

/** The authority one decoded id grants: `ActivationSpec` in `protocol.ts` without the id string. */
export interface Grant {
	readonly seat: string;
	readonly attempt: number;
	readonly purpose: GrantPurpose;
}

//@ contract A decoded id is well formed when its position and attempt are at least one and its seat has a name. The codec's pattern establishes it.
export function wellFormed(id: ActivationFields): boolean {
	//@ ensures \result <==> (id.position >= 1 && id.attempt >= 1 && id.seat.length >= 1)
	return id.position >= 1 && id.attempt >= 1 && id.seat.length >= 1;
}

//@ contract The id of the next attempt carries the cause, its position and the seat unchanged, and numbers the attempt one past those that came to nothing. Nothing mints an id.
export function nextActivationId(
	source: Source,
	position: number,
	seat: string,
	unsuccessfulAttempts: number,
): ActivationFields {
	//@ requires position >= 1
	//@ requires seat.length >= 1
	//@ requires unsuccessfulAttempts >= 0
	//@ ensures \result.source == source && \result.position == position && \result.seat == seat
	//@ ensures \result.attempt == nextAttempt(unsuccessfulAttempts)
	//@ ensures \result.attempt == unsuccessfulAttempts + 1
	//@ ensures wellFormed(\result)
	return { source, position, seat, attempt: nextAttempt(unsuccessfulAttempts) };
}

//@ contract A close names a writer when it carries that name as its summary writer. A close with no writer names nobody.
function names(summary: string | undefined, writer: string): boolean {
	//@ ensures summary == undefined ==> !\result
	//@ ensures summary != undefined ==> (\result <==> summary == writer)
	if (summary === undefined) return false;
	return summary === writer;
}

//@ contract A close answers a closed-source id when its boundary is the id's position and it names the id's seat as writer.
function closeMatches(close: CloseFact, through: number, writer: string): boolean {
	//@ ensures \result <==> (close.through == through && names(close.summary, writer))
	return close.through === through && names(close.summary, writer);
}

//@ contract The close that answers a closed-source id is the first close that matches it. When none matches, there is no close.
export function closeFor(
	closes: readonly CloseFact[],
	through: number,
	writer: string,
): CloseFact | undefined {
	//@ ensures \result != undefined ==> closeMatches(\result, through, writer)
	//@ ensures \result != undefined ==> exists(j, 0 <= j && j < closes.length && closes[j] == \result && forall(k, 0 <= k && k < j ==> !closeMatches(closes[k], through, writer)))
	//@ ensures \result == undefined ==> forall(j, 0 <= j && j < closes.length ==> !closeMatches(closes[j], through, writer))
	return closes.find((close) => closeMatches(close, through, writer));
}

//@ contract A decoded id grants exactly one authority, or nothing. Nothing for a cause before the cancellation marker, for a seat off the roster, or for a seat removed after the cause. A message id grants a response only for a recorded message. A closed id grants a summary only for the close that names the seat, and the summary is over that close's exchange, for its owner, through its boundary. The grant's seat and attempt are the id's own.
export function activationGrant(
	id: ActivationFields,
	cancelledAt: number | undefined,
	seated: boolean,
	removed: boolean,
	recorded: boolean,
	close: CloseFact | undefined,
): Grant | undefined {
	//@ requires wellFormed(id)
	//@ requires close != undefined ==> closeMatches(close, id.position, id.seat)
	//@ ensures \result != undefined ==> \result.seat == id.seat && \result.attempt == id.attempt
	//@ ensures \result != undefined ==> survivesCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined && cancelledAt != undefined ==> !beforeCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined ==> seated
	//@ ensures \result != undefined ==> !removed
	//@ ensures \result != undefined ==> (\result.purpose.kind == 'respond' <==> id.source == 'message')
	//@ ensures \result != undefined && id.source == 'message' ==> recorded && \result.purpose.message == id.position
	//@ ensures \result != undefined && id.source == 'closed' ==> close != undefined && \result.purpose.through == id.position
	//@ ensures \result != undefined && id.source == 'closed' && close != undefined ==> \result.purpose.exchange == close.from && \result.purpose.person == close.owner && \result.purpose.through == close.through
	//@ ensures id.source == 'message' && recorded && survivesCancellation(id.position, cancelledAt) && seated && !removed ==> \result != undefined
	//@ ensures id.source == 'closed' && close != undefined && survivesCancellation(id.position, cancelledAt) && seated && !removed ==> \result != undefined
	if (!survivesCancellation(id.position, cancelledAt)) return undefined;
	if (!seated) return undefined;
	if (removed) return undefined;
	if (id.source === 'message') {
		if (!recorded) return undefined;
		return {
			seat: id.seat,
			attempt: id.attempt,
			purpose: { kind: 'respond', message: id.position },
		};
	}
	if (close === undefined) return undefined;
	return {
		seat: id.seat,
		attempt: id.attempt,
		purpose: {
			kind: 'summarize',
			exchange: close.from,
			person: close.owner,
			through: close.through,
		},
	};
}

//@ contract A lease drafts a close when a close caused it, its position is the close's boundary, and its seat is the close's writer. The id of every attempt the room derives for the writer drafts the close. Another seat's lease drafts nothing for it.
export function draftsClose(id: ActivationFields, through: number, writer: string): boolean {
	//@ requires through >= 1
	//@ requires writer.length >= 1
	//@ ensures \result ==> !holdsExchange(id.source)
	//@ ensures id.seat != writer ==> !\result
	//@ ensures forall(n, n >= 0 ==> draftsClose(nextActivationId('closed', through, writer, n), through, writer))
	return id.source === 'closed' && id.position === through && id.seat === writer;
}

/** A draft of one close's summary, as the verdict reads it: running, or ended with its reason and the marker. */
export type Draft =
	| { readonly phase: 'running' }
	| { readonly phase: 'ended'; readonly reason: LeaseEndReason; readonly cancelled: boolean };

/** The verdict on one close's summary work. A pending verdict is owed while the room still has to send a draft. */
export type Verdict =
	| { readonly status: 'published' }
	| { readonly status: 'pending'; readonly owed: boolean }
	| { readonly status: 'silent' }
	| { readonly status: 'failed' };

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

//@ contract The verdict on one close's summary work: a covering summary beats everything; no named writer is silent; a writer removed after the close failed; a close owes a draft only while nothing stood down and no cancellation cut it.
export function summaryVerdict(
	covered: boolean,
	writerNamed: boolean,
	removedAfterClose: boolean,
	drafts: readonly Draft[],
	cancelledAfterClose: boolean,
): Verdict {
	//@ ensures covered ==> \result.status == 'published'
	//@ ensures \result.status == 'published' ==> covered
	//@ ensures !covered && !writerNamed ==> \result.status == 'silent'
	//@ ensures !covered && writerNamed && removedAfterClose ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !removedAfterClose && !stoodDown(drafts) && !cancelledAfterClose ==> \result.status == 'pending' && \result.owed
	//@ ensures !covered && writerNamed && !removedAfterClose && !stoodDown(drafts) && cancelledAfterClose ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !removedAfterClose && cancelledDraft(drafts, cancelledAfterClose) ==> \result.status == 'failed'
	//@ ensures !covered && writerNamed && !removedAfterClose && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && draftRunning(drafts) ==> \result.status == 'pending' && !\result.owed
	//@ ensures !covered && writerNamed && !removedAfterClose && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && !draftRunning(drafts) && draftReleased(drafts) ==> \result.status == 'silent'
	//@ ensures !covered && writerNamed && !removedAfterClose && stoodDown(drafts) && !cancelledDraft(drafts, cancelledAfterClose) && !draftRunning(drafts) && !draftReleased(drafts) ==> \result.status == 'failed'
	//@ ensures (\result.status == 'pending' && \result.owed) <==> (!covered && writerNamed && !removedAfterClose && !stoodDown(drafts) && !cancelledAfterClose)
	//@ ensures cancelledAfterClose && \result.status == 'pending' ==> !\result.owed
	//@ ensures \result.status == 'pending' && !\result.owed ==> drafts.length > 0
	if (covered) return { status: 'published' };
	if (!writerNamed) return { status: 'silent' };
	if (removedAfterClose) return { status: 'failed' };
	const down = stoodDown(drafts);
	if (cancelledDraft(drafts, cancelledAfterClose)) return { status: 'failed' };
	if (!down && cancelledAfterClose) return { status: 'failed' };
	if (!down) return { status: 'pending', owed: true };
	if (draftRunning(drafts)) return { status: 'pending', owed: false };
	if (draftReleased(drafts)) return { status: 'silent' };
	return { status: 'failed' };
}

/** The range a close holds: the opening question through the last seq at the close. */
interface Range {
	readonly from: number;
	readonly through: number;
}

/** A claim or a renewal. The same union as the two lease commands. */
export type LeaseKind = 'claim' | 'renew';

/** What the admission answers a claim or a renewal. */
export type Admission = 'granted' | 'ended' | 'held';

//@ contract A first claim runs when the room owes the activation and its seat holds no other live lease. A repeated claim and a renewal run while the lease is live. A renewal never starts a lease. An ended or expired lease never runs again.
export function admitsLease(
	kind: LeaseKind,
	known: LeasePhase | undefined,
	live: boolean,
	owed: boolean,
	seatHeld: boolean,
): Admission {
	//@ requires known == undefined ==> !live
	//@ requires known != undefined && known == 'ended' ==> !live
	//@ ensures \result == 'granted' ==> (kind == 'claim' && known == undefined && owed && !seatHeld) || live
	//@ ensures live ==> \result == 'granted'
	//@ ensures kind == 'renew' && known == undefined ==> \result == 'ended'
	//@ ensures known != undefined && !live ==> \result == 'ended'
	//@ ensures known == undefined && !owed ==> \result == 'ended'
	//@ ensures kind == 'claim' && known == undefined && owed && seatHeld ==> \result == 'held'
	//@ ensures kind == 'claim' && known == undefined && owed && !seatHeld ==> \result == 'granted'
	//@ ensures known != undefined ==> \result != 'held'
	//@ ensures \result == 'held' ==> known == undefined && seatHeld
	if (known === undefined && (kind === 'renew' || !owed)) return 'ended';
	if (known === undefined && seatHeld) return 'held';
	if (known !== undefined && !live) return 'ended';
	return 'granted';
}

/** What a closing commit stamps: the recipient and the covered range. */
export interface Stamped {
	readonly to: string;
	readonly covers: Range;
}

//@ contract The summary a closing commit stamps covers its own exchange, so a second closing commit for the same exchange is refused.
export function stampedSummary(owner: string, from: number, through: number): Stamped {
	//@ ensures \result.to == owner
	//@ ensures \result.covers.from == from && \result.covers.through == through
	//@ ensures coversExchange(\result.to, \result.covers.from, \result.covers.through, owner, from, through)
	return { to: owner, covers: { from, through } };
}

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

//@ contract A message opens an exchange after the last close when a person spoke it, or when the room returned a say for a person: agent speech, arrivals and departures open nothing.
function opensExchange(
	message: Message,
	people: readonly string[],
	closedThrough: number,
): boolean {
	//@ ensures message.kind == 'said' ==> (\result <==> people.includes(message.from) && message.seq > closedThrough)
	//@ ensures message.kind == 'returned' ==> (\result <==> people.includes(message.owner) && message.seq > closedThrough)
	//@ ensures message.kind != 'said' && message.kind != 'returned' ==> !\result
	//@ ensures message.seq <= closedThrough ==> !\result
	if (message.seq <= closedThrough) return false;
	if (message.kind === 'returned') return people.includes(message.owner);
	return message.kind === 'said' && people.includes(message.from);
}

//@ contract The open exchange is the first message that opens one after the last close; there is at most one, and its position is on the record.
export function openingQuestion(
	messages: readonly Message[],
	people: readonly string[],
	closedThrough: number,
): Message | undefined {
	//@ requires forall(i, forall(j, 0 <= i && i < j && j < messages.length ==> messages[i].seq < messages[j].seq))
	//@ ensures \result != undefined ==> opensExchange(\result, people, closedThrough) && \result.seq > closedThrough
	//@ ensures \result == undefined <==> !exists(i, 0 <= i && i < messages.length && opensExchange(messages[i], people, closedThrough))
	//@ ensures \result != undefined ==> exists(i, 0 <= i && i < messages.length && messages[i] == \result && forall(j, 0 <= j && j < i ==> !opensExchange(messages[j], people, closedThrough)))
	//@ ensures \result != undefined ==> messages.length > 0 && \result.seq <= messages[messages.length - 1].seq
	return messages.find((message) => opensExchange(message, people, closedThrough));
}
