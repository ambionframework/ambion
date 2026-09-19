/**
 * The rules the room decides by, as functions LemmaScript checks. Every
 * function here is pure, and `lease.ts`, `reconcile.ts`, `delivery.ts`,
 * `routing.ts`, `presence.ts`, `activation.ts`, and `transition.ts` run
 * these bodies: the proof is about the code the room runs. `lsc check` turns the `//@` annotations into Dafny
 * obligations, and CI verifies them.
 *
 * The string unions below are declared again beside the rules, because
 * LemmaScript lowers only the types in its own file. `rules.test.ts`
 * asserts each copy equals the public type in `types.ts`.
 */

/** The two phases a lease holds. */
export type LeasePhase = 'running' | 'ended';

/** Why a lease ended. The same union as `EndReason` in `types.ts`. */
export type LeaseEndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** What an activation is for: an answer to a message, or a closing summary. */
export type Purpose = 'respond' | 'summarize';

/** What a commit asks for. */
export type Intent = 'said' | 'seated' | 'unseated';

//@ contract A lease is past its expiry once now reaches it.
function expired(expiry: number, now: number): boolean {
	//@ ensures \result <==> expiry <= now
	return expiry <= now;
}

//@ contract A lease was at work when a message landed: it held a change before the message, and ended, if it ended, after it. A message heard at work is one the lease covers.
function atWork(since: number, ended: boolean, until: number, seq: number): boolean {
	//@ ensures \result ==> since < seq
	//@ ensures \result && ended ==> until >= seq
	//@ ensures !ended ==> (\result <==> since < seq)
	//@ ensures \result ==> coversAttempt(ended, until, seq)
	//@ ensures !\result ==> seq <= since || (ended && until < seq)
	return since < seq && (!ended || until >= seq);
}

//@ contract A lease covers an entry while it attempts work, and every earlier entry with it.
export function coversAttempt(ended: boolean, until: number, seq: number): boolean {
	//@ ensures !ended ==> \result
	//@ ensures ended ==> (\result <==> seq <= until)
	//@ ensures \result ==> forall(earlier, earlier <= seq ==> coversAttempt(ended, until, earlier))
	return !ended || seq <= until;
}

//@ contract The room gives a wake up once the attempts reach the cap.
export function givesUp(attempts: number, cap: number): boolean {
	//@ requires attempts >= 0
	//@ requires cap >= 1
	//@ ensures \result <==> attempts >= cap
	//@ ensures !\result ==> attempts + 1 <= cap
	return attempts >= cap;
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

//@ contract Both purposes permit speech. Only a response permits a seating or an unseating. A closing activation can do nothing but speak.
export function permits(purpose: Purpose, intent: Intent): boolean {
	//@ ensures intent == 'said' ==> \result
	//@ ensures intent != 'said' ==> (\result <==> purpose == 'respond')
	//@ ensures purpose == 'summarize' ==> (\result <==> intent == 'said')
	//@ ensures purpose == 'respond' ==> \result
	switch (intent) {
		case 'said':
			return purpose === 'respond' || purpose === 'summarize';
		case 'seated':
		case 'unseated':
			return purpose === 'respond';
	}
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
	return summaryTo === owner && summaryFrom <= from && summaryThrough >= through;
}

//@ contract Work survives a cancellation when no marker stands, or its cause is at or after the marker.
export function survivesCancellation(position: number, cancelledAt: number | undefined): boolean {
	//@ ensures cancelledAt == undefined ==> \result
	//@ ensures cancelledAt != undefined ==> (\result <==> !beforeCancellation(position, cancelledAt))
	//@ ensures cancelledAt != undefined ==> (\result <==> position >= cancelledAt)
	if (cancelledAt === undefined) return true;
	return !beforeCancellation(position, cancelledAt);
}

/** The lease the fold holds for one id. `LeaseHold` in `lease.ts` is this plus the derived `cancelled` marker. */
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
			until: number;
	  };

/** One lease entry, as the journal records it. The same shape as `LeaseChange` in `events.ts`. */
export type Change =
	| { id: string; phase: 'running'; expiresAt: number; at: string; readThrough: number }
	| { id: string; phase: 'ended'; reason: LeaseEndReason; at: string; readThrough: number };

/** A lease that covers a message, as the wake rules read it: its phase, reason, acknowledgment, and the position its id names. */
export type Taken =
	| { phase: 'running'; readThrough: number; position: number }
	| { phase: 'ended'; reason: LeaseEndReason; readThrough: number; position: number };

/** When the next attempt may start, and its number. */
export interface Schedule {
	readonly attempt: number;
	readonly notBefore: number | undefined;
}

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
	//@ ensures known == undefined && change.phase == 'ended' ==> \result.phase == 'ended' && \result.until == seq && \result.reason == change.reason
	//@ ensures known != undefined && known.phase == 'running' && change.phase == 'ended' ==> \result.phase == 'ended' && \result.until == seq && \result.reason == change.reason
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
		until: seq,
	};
}

//@ contract A cancellation marker ends every running lease whose cause is before it as revoked, at the marker's seq, and keeps its id, since, claimedAt and readThrough. An ended lease, and a running lease caused at or after the marker, stay as they are.
export function cancelHold(hold: Hold, position: number, cancelledAt: number, at: string): Hold {
	//@ requires hold.since <= cancelledAt
	//@ ensures hold.phase == 'ended' ==> \result == hold
	//@ ensures hold.phase == 'running' && !beforeCancellation(position, cancelledAt) ==> \result == hold
	//@ ensures hold.phase == 'running' && beforeCancellation(position, cancelledAt) ==> \result.phase == 'ended' && \result.reason == 'revoked' && \result.until == cancelledAt && \result.at == at
	//@ ensures \result.readThrough == hold.readThrough
	//@ ensures \result.since == hold.since
	//@ ensures \result.claimedAt == hold.claimedAt
	//@ ensures \result.id == hold.id
	//@ ensures \result.phase == 'ended' && hold.phase == 'running' ==> \result.since <= \result.until
	if (hold.phase === 'ended' || !beforeCancellation(position, cancelledAt)) return hold;
	return {
		id: hold.id,
		phase: 'ended',
		at,
		claimedAt: hold.claimedAt,
		since: hold.since,
		readThrough: hold.readThrough,
		reason: 'revoked',
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
export function cameToNothing(reason: LeaseEndReason): boolean {
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

//@ contract The latest of the times, and at least the floor.
export function latest(times: number[], floor: number): number {
	//@ requires floor >= 0
	//@ ensures \result >= floor
	//@ ensures forall(i, 0 <= i && i < times.length ==> \result >= times[i])
	let best = floor;
	for (let i = 0; i < times.length; i++) {
		//@ invariant 0 <= i && i <= times.length
		//@ invariant best >= floor
		//@ invariant forall(k, 0 <= k && k < i ==> best >= times[k])
		const v = times[i] ?? floor;
		if (v > best) best = v;
	}
	return best;
}

//@ contract A first attempt waits for nothing. After attempts that came to nothing, the next is numbered one past them and starts no earlier than the last one's end plus the backoff.
export function schedule(unsuccessful: number, last: number, backoff: number): Schedule {
	//@ requires unsuccessful >= 0
	//@ requires last >= 0
	//@ ensures \result.attempt == nextAttempt(unsuccessful)
	//@ ensures unsuccessful == 0 ==> \result.notBefore == undefined
	//@ ensures unsuccessful > 0 ==> \result.notBefore != undefined && \result.notBefore == last + backoff
	//@ ensures unsuccessful > 0 && backoff >= 0 ==> \result.notBefore != undefined && \result.notBefore >= last
	return {
		attempt: nextAttempt(unsuccessful),
		notBefore: unsuccessful === 0 ? undefined : last + backoff,
	};
}

//@ contract A removal after seq settles seq and every earlier position.
export function removedAfter(removals: number[], seq: number): boolean {
	//@ decreases removals.length
	//@ ensures \result <==> exists(i, 0 <= i && i < removals.length && removals[i] > seq)
	//@ ensures \result ==> forall(earlier, earlier <= seq ==> removedAfter(removals, earlier))
	if (removals.length === 0) return false;
	const head = removals[0] ?? seq;
	return head > seq || removedAfter(removals.slice(1), seq);
}

/** How a running lease ends in a pass, or that it stays. */
export type Ending = 'revoked' | 'expired' | 'stays';

/** The journal fact that caused an activation. The same union as `ActivationSource`. */
export type Source = 'message' | 'closed';

//@ contract An activation is ready when its backoff is over and its resend window is over.
export function readyToSend(
	now: number,
	backedOff: boolean,
	notBefore: number,
	wasSent: boolean,
	sentAt: number,
	resend: number,
): boolean {
	//@ requires resend >= 0
	//@ ensures \result <==> ((!backedOff || notBefore <= now) && (!wasSent || sentAt + resend <= now))
	//@ ensures backedOff && notBefore > now ==> !\result
	//@ ensures wasSent && now < sentAt + resend ==> !\result
	const backoffOver = !backedOff || notBefore <= now;
	const windowOver = !wasSent || sentAt + resend <= now;
	return backoffOver && windowOver;
}

//@ contract When the room sends one activation it owes: the backoff when it is ahead, else the end of the resend window, else now. The wait is over exactly when the activation is ready.
function waitsUntil(
	now: number,
	backedOff: boolean,
	notBefore: number,
	wasSent: boolean,
	sentAt: number,
	resend: number,
): number {
	//@ requires resend >= 0
	//@ ensures \result <= now <==> readyToSend(now, backedOff, notBefore, wasSent, sentAt, resend)
	//@ ensures backedOff && notBefore > now ==> \result == notBefore
	//@ ensures (!backedOff || notBefore <= now) && wasSent ==> \result == sentAt + resend
	//@ ensures (!backedOff || notBefore <= now) && !wasSent ==> \result == now
	const backoff = backedOff ? notBefore : now;
	if (backoff > now) return backoff;
	return wasSent ? sentAt + resend : now;
}

//@ contract When the room looks at an activation again: its wait when the wait is ahead, else one resend window from now. Always after now.
export function looksAgainAt(
	now: number,
	backedOff: boolean,
	notBefore: number,
	wasSent: boolean,
	sentAt: number,
	resend: number,
): number {
	//@ requires resend >= 1
	//@ ensures \result > now
	//@ ensures !readyToSend(now, backedOff, notBefore, wasSent, sentAt, resend) ==> \result == waitsUntil(now, backedOff, notBefore, wasSent, sentAt, resend)
	//@ ensures readyToSend(now, backedOff, notBefore, wasSent, sentAt, resend) ==> \result == now + resend
	const at = waitsUntil(now, backedOff, notBefore, wasSent, sentAt, resend);
	return at > now ? at : now + resend;
}

//@ contract The earliest time after now among the given times, or nothing when none is after now.
export function earliestAfter(now: number, times: readonly number[]): number | undefined {
	//@ decreases times.length
	//@ ensures \result != undefined ==> \result > now
	//@ ensures \result == undefined <==> forall(i, 0 <= i && i < times.length ==> times[i] <= now)
	//@ ensures \result != undefined ==> forall(i, 0 <= i && i < times.length && times[i] > now ==> \result <= times[i])
	//@ ensures \result != undefined ==> exists(i, 0 <= i && i < times.length && times[i] == \result)
	if (times.length === 0) return undefined;
	const head = times[0] ?? now;
	const rest = earliestAfter(now, times.slice(1));
	if (head <= now) return rest;
	if (rest === undefined) return head;
	return head < rest ? head : rest;
}

//@ contract A lease is stale when the room did not derive its id, its seat left the roster, or a removal of its seat landed after its cause.
export function staleLease(derived: boolean, seated: boolean, removedAfterCause: boolean): boolean {
	//@ ensures \result <==> (!derived || !seated || removedAfterCause)
	//@ ensures derived && seated && !removedAfterCause ==> !\result
	return !derived || !seated || removedAfterCause;
}

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

//@ contract The room closes the open exchange only on a pass that ends no lease and writes off no activation, when nothing the exchange caused is live, and the room runs.
export function mayClose(
	stopped: boolean,
	endings: number,
	exchangeOpen: boolean,
	exchangeLive: boolean,
): boolean {
	//@ requires endings >= 0
	//@ ensures \result ==> !stopped
	//@ ensures \result ==> endings == 0
	//@ ensures \result ==> exchangeOpen
	//@ ensures \result ==> !exchangeLive
	//@ ensures !stopped && endings == 0 && exchangeOpen && !exchangeLive ==> \result
	return !stopped && endings === 0 && exchangeOpen && !exchangeLive;
}

//@ contract A close that did not land still counts as progress when the same exchange is open and the record moved or its work is live. It never counts on a reading where the close is admitted.
export function closeMoved(
	open: OpenExchange | undefined,
	close: CloseRef,
	lastSeq: number,
	exchangeLive: boolean,
): boolean {
	//@ ensures \result ==> open != undefined
	//@ ensures open != undefined ==> (\result <==> (open.from == close.from && (lastSeq != close.through || exchangeLive)))
	//@ ensures \result ==> !admitsClose(open, close, lastSeq, exchangeLive)
	//@ ensures admitsClose(open, close, lastSeq, exchangeLive) ==> !\result
	if (open === undefined) return false;
	return open.from === close.from && (lastSeq !== close.through || exchangeLive);
}

//@ contract The ids this room sent that the fold no longer owes: every id kept was sent and is not due, and every sent id that is not due is kept.
export function forgets(sentIds: readonly string[], dueIds: readonly string[]): string[] {
	//@ ensures \result.length <= sentIds.length
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !dueIds.includes(\result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> sentIds.includes(\result[i]))
	//@ ensures forall(i, 0 <= i && i < sentIds.length && !dueIds.includes(sentIds[i]) ==> \result.includes(sentIds[i]))
	//@ ensures forall(i, 0 <= i && i < dueIds.length ==> !\result.includes(dueIds[i]))
	const out: string[] = [];
	let i = 0;
	while (i < sentIds.length) {
		//@ invariant 0 <= i && i <= sentIds.length
		//@ invariant out.length <= i
		//@ invariant forall(k, 0 <= k && k < out.length ==> !dueIds.includes(out[k]))
		//@ invariant forall(k, 0 <= k && k < out.length ==> sentIds.includes(out[k]))
		//@ invariant forall(k, 0 <= k && k < i && !dueIds.includes(sentIds[k]) ==> out.includes(sentIds[k]))
		//@ decreases sentIds.length - i
		const id = sentIds[i] ?? '';
		if (!dueIds.includes(id)) out.push(id);
		i++;
	}
	return out;
}

//@ contract A close names the configured summary writer only when that writer is seated at the close.
export function namesWriter(configured: boolean, seated: boolean): boolean {
	//@ ensures \result ==> configured
	//@ ensures \result ==> seated
	//@ ensures configured && seated ==> \result
	return configured && seated;
}

//@ contract A lease past its expiry stays past it at every later clock reading.
export function stillExpired(expiry: number, now: number, later: number): boolean {
	//@ requires now <= later
	//@ ensures expired(expiry, now) ==> \result
	//@ ensures \result <==> expired(expiry, later)
	return expired(expiry, now) || expired(expiry, later);
}

//@ contract An ending the decision made at one clock reading is one the write accepts at every later reading: an expiry stays expired, and a revocation needs no clock.
export function endingStands(stale: boolean, expiry: number, now: number, later: number): boolean {
	//@ requires now <= later
	//@ ensures endingOf(true, stale, expired(expiry, now)) == 'expired' ==> mayEnd('running', 'expired', expired(expiry, later))
	//@ ensures endingOf(true, stale, expired(expiry, now)) == 'revoked' ==> mayEnd('running', 'revoked', expired(expiry, later))
	//@ ensures \result <==> endingOf(true, stale, expired(expiry, now)) != 'stays'
	const ending = endingOf(true, stale, expired(expiry, now));
	if (ending === 'expired') return mayEnd('running', 'expired', stillExpired(expiry, now, later));
	if (ending === 'revoked') return mayEnd('running', 'revoked', expired(expiry, later));
	return false;
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

/** What wakes a seat. The same union as `Attention` in `types.ts`. */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** Every kind of message on the record. The same union as `Message['kind']` in `types.ts`. */
export type MessageKind = 'said' | 'arrived' | 'left' | 'seated' | 'unseated' | 'summary';

/** One seat on the roster, as the routing reads it. `Seating` in `events.ts` is this plus an identity. */
export interface Seat {
	readonly name: string;
	readonly attention: Attention;
}

//@ contract The attention scale is one total order, narrowest first: none is 0, named 1, broadcast 2, presence 3.
function width(attention: Attention): number {
	//@ ensures 0 <= \result && \result <= 3
	//@ ensures \result == 0 <==> attention == 'none'
	//@ ensures \result == 1 <==> attention == 'named'
	//@ ensures \result == 2 <==> attention == 'broadcast'
	//@ ensures \result == 3 <==> attention == 'presence'
	if (attention === 'named') return 1;
	if (attention === 'broadcast') return 2;
	if (attention === 'presence') return 3;
	return 0;
}

//@ contract A summary reaches no seat (0), a directed say reaches the one it names (1), anything else said reaches the room (2), and a presence change or a seating reaches the widest end (3).
export function reachOf(kind: MessageKind, directed: boolean): number {
	//@ ensures 0 <= \result && \result <= 3
	//@ ensures kind == 'summary' ==> \result == 0
	//@ ensures kind == 'said' && directed ==> \result == 1
	//@ ensures kind == 'said' && !directed ==> \result == 2
	//@ ensures kind != 'said' && kind != 'summary' ==> \result == 3
	if (kind === 'summary') return 0;
	if (kind !== 'said') return 3;
	return directed ? 1 : 2;
}

//@ contract A directed say names the seat it addresses, a seating names the seat it seats, and no other message names a seat.
export function targetOf(
	kind: MessageKind,
	to: string | undefined,
	subject: string | undefined,
): string | undefined {
	//@ ensures kind == 'said' && to == undefined ==> \result == undefined
	//@ ensures kind == 'said' && to != undefined ==> \result != undefined
	//@ ensures \result != undefined && to != undefined && kind == 'said' ==> \result == to
	//@ ensures kind == 'seated' && subject != undefined ==> \result != undefined
	//@ ensures \result != undefined && subject != undefined && kind == 'seated' ==> \result == subject
	//@ ensures kind != 'said' && kind != 'seated' ==> \result == undefined
	if (kind === 'said') return to;
	if (kind === 'seated') return subject;
	return undefined;
}

//@ contract The message names this seat: it has a target, and the target is this name.
export function isNamed(target: string | undefined, name: string): boolean {
	//@ ensures target == undefined ==> !\result
	//@ ensures target != undefined ==> (\result <==> target == name)
	if (target !== undefined && target === name) return true;
	return false;
}

//@ contract This seat wrote the message. A seating the host decided has no author.
function isAuthor(author: string | undefined, name: string): boolean {
	//@ ensures author == undefined ==> !\result
	//@ ensures author != undefined ==> (\result <==> author == name)
	if (author !== undefined && author === name) return true;
	return false;
}

//@ contract A seat the message names wakes however narrowly it is seated. Any other seat wakes only when its attention is at least as wide as the reach, and a directed say or a summary wakes no seat it does not name.
export function wakes(attention: Attention, named: boolean, reach: number): boolean {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures named ==> \result
	//@ ensures !named && reach == 0 ==> !\result
	//@ ensures !named && reach == 1 ==> !\result
	//@ ensures !named && reach == 2 ==> (\result <==> (attention == 'broadcast' || attention == 'presence'))
	//@ ensures !named && reach == 3 ==> (\result <==> attention == 'presence')
	//@ ensures !named && reach >= 2 ==> (\result <==> width(attention) >= reach)
	//@ ensures !named && \result ==> width(attention) >= reach
	if (named) return true;
	if (reach === 0) return false;
	if (width(attention) < reach) return false;
	return reach !== 1;
}

//@ contract For one seat: a message never wakes its author, never wakes a seat at ordinary work, always wakes the idle seat it names, and otherwise wakes the seat exactly when the scale says so.
function wokenBy(
	seat: Seat,
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: boolean,
): boolean {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures busy ==> !\result
	//@ ensures isAuthor(author, seat.name) ==> !\result
	//@ ensures !busy && !isAuthor(author, seat.name) && isNamed(target, seat.name) ==> \result
	//@ ensures reach == 1 && \result ==> isNamed(target, seat.name)
	//@ ensures reach == 0 && \result ==> isNamed(target, seat.name)
	//@ ensures !busy && !isAuthor(author, seat.name) ==> (\result <==> wakes(seat.attention, isNamed(target, seat.name), reach))
	if (busy) return false;
	if (isAuthor(author, seat.name)) return false;
	return wakes(seat.attention, isNamed(target, seat.name), reach);
}

//@ contract A name is held when it is among the seats at ordinary work.
function held(busy: string[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < busy.length && busy[i] == name)
	return busy.includes(name);
}

//@ contract A name is on the roster when some seat carries it.
export function onRoster(roster: readonly Seat[], name: string): boolean {
	//@ ensures \result <==> exists(i, 0 <= i && i < roster.length && roster[i].name == name)
	return roster.some((seat) => seat.name === name);
}

//@ contract One more name at the end, and every earlier name where it was.
function append(names: string[], name: string): string[] {
	//@ ensures \result.length == names.length + 1
	//@ ensures \result[names.length] == name
	//@ ensures forall(i, 0 <= i && i < names.length ==> \result[i] == names[i])
	return [...names, name];
}

//@ contract Who a message wakes among the first r seats of the roster: never the author, never a seat at ordinary work, only roster names, for a directed say or a summary nobody but the target, and every seat wokenBy admits.
function wokenUpTo(
	roster: Seat[],
	r: number,
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: string[],
): string[] {
	//@ requires 0 <= reach && reach <= 3
	//@ requires 0 <= r && r <= roster.length
	//@ decreases r
	//@ ensures \result.length <= r
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !isAuthor(author, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !held(busy, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> onRoster(roster, \result[i]))
	//@ ensures reach == 1 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures reach == 0 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures forall(s, 0 <= s && s < r && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[s].name))
	if (r === 0) return [];
	const seat = roster[r - 1] as Seat;
	const before = wokenUpTo(roster, r - 1, author, target, reach, busy);
	if (wokenBy(seat, author, target, reach, held(busy, seat.name))) return append(before, seat.name);
	return before;
}

//@ contract Who a message wakes on the roster: never the author, never a seat at ordinary work, only roster names, for a directed say or a summary nobody but the target, and every seat wokenBy admits.
export function woken(
	roster: Seat[],
	author: string | undefined,
	target: string | undefined,
	reach: number,
	busy: string[],
): string[] {
	//@ requires 0 <= reach && reach <= 3
	//@ ensures \result.length <= roster.length
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !isAuthor(author, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> !held(busy, \result[i]))
	//@ ensures forall(i, 0 <= i && i < \result.length ==> onRoster(roster, \result[i]))
	//@ ensures reach == 1 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures reach == 0 ==> forall(i, 0 <= i && i < \result.length ==> isNamed(target, \result[i]))
	//@ ensures forall(s, 0 <= s && s < roster.length && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists(i, 0 <= i && i < \result.length && \result[i] == roster[s].name))
	return wokenUpTo(roster, roster.length, author, target, reach, busy);
}

//@ contract The room changes before the message does: a seating's newcomer is on the roster the routing reads, at the attention the seating names or broadcast when it names none, and every existing seat is unchanged.
export function rosterFor(
	roster: Seat[],
	seated: boolean,
	subject: string,
	attention: Attention | undefined,
): Seat[] {
	//@ ensures !seated ==> \result == roster
	//@ ensures seated ==> \result.length == roster.length + 1
	//@ ensures seated ==> \result[roster.length].name == subject
	//@ ensures seated && attention == undefined ==> \result[roster.length].attention == 'broadcast'
	//@ ensures seated && attention != undefined ==> \result[roster.length].attention == attention
	//@ ensures forall(i, 0 <= i && i < roster.length ==> \result[i] == roster[i])
	if (!seated) return roster;
	return [
		...roster,
		{ name: subject, attention: attention !== undefined ? attention : 'broadcast' },
	];
}

//@ contract A lease was at work when a message landed: it held a change before the message, and ended, if it ended, at or after it.
function atWorkHold(hold: Hold, seq: number): boolean {
	//@ ensures \result ==> hold.since < seq
	//@ ensures hold.phase == 'running' ==> (\result <==> hold.since < seq)
	//@ ensures hold.phase == 'ended' ==> (\result <==> (hold.since < seq && seq <= hold.until))
	if (hold.phase === 'running') return atWork(hold.since, false, 0, seq);
	return atWork(hold.since, true, hold.until, seq);
}

//@ contract A message steers an ordinary lease that was at work when the message landed, and never the author's seat, a seat the message wakes, or a closing lease.
export function steers(
	source: Source,
	seat: string,
	author: string | undefined,
	woken: boolean,
	hold: Hold,
	seq: number,
): boolean {
	//@ ensures \result ==> source == 'message'
	//@ ensures \result ==> !woken
	//@ ensures isAuthor(author, seat) ==> !\result
	//@ ensures \result ==> atWorkHold(hold, seq)
	//@ ensures source == 'message' && !woken && !isAuthor(author, seat) && atWorkHold(hold, seq) ==> \result
	if (source !== 'message') return false;
	if (woken) return false;
	if (isAuthor(author, seat)) return false;
	return atWorkHold(hold, seq);
}

/** A person is in the room or they are not. The same union as `PresenceStatus` in `types.ts`. */
export type Presence = 'present' | 'absent';

/** One person the record knows. The same fields as `PersonState` in `presence.ts`. */
export interface Person {
	readonly name: string;
	readonly identity: string;
	readonly presence: Presence;
	readonly since: number | undefined;
	readonly changedAt: string | undefined;
	readonly preferences: string | undefined;
}

/** One message projected to what the presence fold reads. */
export interface PresenceEntry {
	readonly kind: MessageKind;
	readonly name: string;
	readonly seq: number;
	readonly at: string;
	readonly identity: string | undefined;
	readonly preferences: string | undefined;
}

//@ contract A known person is present when the record says so; an unknown name is not present.
export function present(person: Person | undefined): boolean {
	//@ ensures person == undefined ==> !\result
	//@ ensures person != undefined ==> (\result <==> person.presence == 'present')
	if (person !== undefined && person.presence === 'present') return true;
	return false;
}

//@ contract An arrival keeps the identity it carries, or the one the record knows, or none.
function identityOn(known: Person | undefined, identity: string | undefined): string {
	//@ ensures identity != undefined ==> \result == identity
	//@ ensures known != undefined && identity == undefined ==> \result == known.identity
	//@ ensures known == undefined && identity == undefined ==> \result == ''
	if (identity !== undefined) return identity;
	if (known !== undefined) return known.identity;
	return '';
}

//@ contract An arrival keeps the preferences it carries, or the ones the record knows, or none.
function preferencesOn(
	known: Person | undefined,
	preferences: string | undefined,
): string | undefined {
	//@ ensures preferences != undefined ==> \result == preferences
	//@ ensures known != undefined && preferences == undefined ==> \result == known.preferences
	//@ ensures known == undefined && preferences == undefined ==> \result == undefined
	if (preferences !== undefined) return preferences;
	if (known !== undefined) return known.preferences;
	return undefined;
}

//@ contract An arrival makes a person present. It keeps the cursor of their last departure, and keeps their identity and preferences unless the arrival carries them.
function arrive(known: Person | undefined, entry: PresenceEntry): Person {
	//@ ensures \result.presence == 'present'
	//@ ensures \result.name == entry.name
	//@ ensures \result.changedAt == entry.at
	//@ ensures known != undefined ==> \result.since == known.since
	//@ ensures known == undefined ==> \result.since == undefined
	//@ ensures entry.identity != undefined ==> \result.identity == entry.identity
	//@ ensures known != undefined && entry.identity == undefined ==> \result.identity == known.identity
	//@ ensures known == undefined && entry.identity == undefined ==> \result.identity == ''
	//@ ensures entry.preferences != undefined ==> \result.preferences == entry.preferences
	//@ ensures known != undefined && entry.preferences == undefined ==> \result.preferences == known.preferences
	//@ ensures known == undefined && entry.preferences == undefined ==> \result.preferences == undefined
	return {
		name: entry.name,
		identity: identityOn(known, entry.identity),
		presence: 'present',
		since: known !== undefined ? known.since : undefined,
		changedAt: entry.at,
		preferences: preferencesOn(known, entry.preferences),
	};
}

//@ contract A departure makes a known person absent at its seq and keeps their identity and preferences. A departure of an unknown name records nothing.
function depart(known: Person | undefined, entry: PresenceEntry): Person | undefined {
	//@ ensures known == undefined ==> \result == undefined
	//@ ensures known != undefined ==> \result != undefined
	//@ ensures \result != undefined ==> \result.presence == 'absent'
	//@ ensures \result != undefined ==> \result.name == entry.name
	//@ ensures \result != undefined ==> \result.since == entry.seq
	//@ ensures \result != undefined ==> \result.changedAt == entry.at
	//@ ensures \result != undefined && known != undefined ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined ==> \result.preferences == known.preferences
	if (known === undefined) return undefined;
	return {
		name: entry.name,
		identity: known.identity,
		presence: 'absent',
		since: entry.seq,
		changedAt: entry.at,
		preferences: known.preferences,
	};
}

//@ contract One presence entry applied to one person. An arrival makes the person present, keeps their last-departure cursor, and keeps their identity unless the arrival carries one. A departure makes a known person absent at its seq and keeps identity and preferences. A departure of an unknown name and every other kind record nothing.
function stepPerson(known: Person | undefined, entry: PresenceEntry): Person | undefined {
	//@ ensures entry.kind == 'arrived' ==> \result != undefined
	//@ ensures entry.kind == 'arrived' ==> present(\result)
	//@ ensures entry.kind == 'left' ==> !present(\result)
	//@ ensures entry.kind == 'left' && known == undefined ==> \result == undefined
	//@ ensures entry.kind == 'left' && known != undefined ==> \result != undefined
	//@ ensures entry.kind != 'arrived' && entry.kind != 'left' ==> (present(\result) <==> present(known))
	//@ ensures \result != undefined && (entry.kind == 'arrived' || entry.kind == 'left') ==> \result.name == entry.name
	//@ ensures \result != undefined && (entry.kind == 'arrived' || entry.kind == 'left') ==> \result.changedAt == entry.at
	//@ ensures \result != undefined && entry.kind == 'left' ==> \result.since == entry.seq
	//@ ensures \result != undefined && known != undefined && entry.kind == 'arrived' ==> \result.since == known.since
	//@ ensures \result != undefined && known == undefined && entry.kind == 'arrived' ==> \result.since == undefined
	//@ ensures \result != undefined && entry.identity != undefined && entry.kind == 'arrived' ==> \result.identity == entry.identity
	//@ ensures \result != undefined && known != undefined && entry.identity == undefined && entry.kind == 'arrived' ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined && entry.kind == 'left' ==> \result.identity == known.identity
	//@ ensures \result != undefined && known != undefined && entry.kind == 'left' ==> \result.preferences == known.preferences
	if (entry.kind === 'arrived') return arrive(known, entry);
	if (entry.kind === 'left') return depart(known, entry);
	return known;
}

//@ contract Every person the record knows: a name is known once it arrived, and a known name is present exactly when its last presence entry is an arrival.
export function foldPresence(entries: PresenceEntry[]): Map<string, Person> {
	//@ ensures forall(n: string, \result.has(n) ==> (present(\result.get(n)) <==> exists(k, 0 <= k && k < entries.length && entries[k].name == n && entries[k].kind == 'arrived' && forall(j, k < j && j < entries.length && entries[j].name == n ==> entries[j].kind != 'left'))))
	//@ ensures forall(k, 0 <= k && k < entries.length && entries[k].kind == 'arrived' ==> \result.has(entries[k].name))
	const people: Map<string, Person> = new Map();
	for (let i = 0; i < entries.length; i++) {
		//@ invariant 0 <= i && i <= entries.length
		//@ invariant forall(n: string, people.has(n) ==> (present(people.get(n)) <==> exists(k, 0 <= k && k < i && entries[k].name == n && entries[k].kind == 'arrived' && forall(j, k < j && j < i && entries[j].name == n ==> entries[j].kind != 'left'))))
		//@ invariant forall(k, 0 <= k && k < i && entries[k].kind == 'arrived' ==> people.has(entries[k].name))
		const entry = entries[i] as PresenceEntry;
		const next = stepPerson(people.get(entry.name), entry);
		if (next !== undefined) people.set(entry.name, next);
	}
	return people;
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
	roster: readonly Seat[],
	removed: boolean,
	recorded: boolean,
	close: CloseFact | undefined,
): Grant | undefined {
	//@ requires wellFormed(id)
	//@ requires close != undefined ==> closeMatches(close, id.position, id.seat)
	//@ ensures \result != undefined ==> \result.seat == id.seat && \result.attempt == id.attempt
	//@ ensures \result != undefined ==> survivesCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined && cancelledAt != undefined ==> !beforeCancellation(id.position, cancelledAt)
	//@ ensures \result != undefined ==> onRoster(roster, id.seat)
	//@ ensures \result != undefined ==> !removed
	//@ ensures \result != undefined ==> (\result.purpose.kind == 'respond' <==> id.source == 'message')
	//@ ensures \result != undefined && id.source == 'message' ==> recorded && \result.purpose.message == id.position
	//@ ensures \result != undefined && id.source == 'closed' ==> close != undefined && \result.purpose.through == id.position
	//@ ensures \result != undefined && id.source == 'closed' && close != undefined ==> \result.purpose.exchange == close.from && \result.purpose.person == close.owner && \result.purpose.through == close.through
	//@ ensures id.source == 'message' && recorded && survivesCancellation(id.position, cancelledAt) && onRoster(roster, id.seat) && !removed ==> \result != undefined
	//@ ensures id.source == 'closed' && close != undefined && survivesCancellation(id.position, cancelledAt) && onRoster(roster, id.seat) && !removed ==> \result != undefined
	if (!survivesCancellation(id.position, cancelledAt)) return undefined;
	if (!onRoster(roster, id.seat)) return undefined;
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
