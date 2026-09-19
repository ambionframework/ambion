/**
 * The rules the room decides by, as functions LemmaScript checks. Every
 * function here is pure, and `lease.ts`, `reconcile.ts`, `transition.ts`,
 * `activation.ts`, `exchange.ts`, `fold.ts`, `answers.ts`, and the host
 * run these bodies: the proof is about the code the room runs. `lsc check`
 * turns the `//@` annotations into Dafny obligations, and CI verifies them.
 * `rules.verified.proofs.dfy` beside this file carries the lemmas the
 * generator cannot write.
 *
 * The string unions below are declared again beside the rules, because
 * LemmaScript lowers only the types in its own file. `rules.test.ts`
 * asserts each copy equals the public type in `types.ts`. The routing,
 * presence, and roster rules are in `rules.roster.verified.ts`, and the
 * rules over the message list in `rules.record.verified.ts`.
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
export interface Range {
	readonly from: number;
	readonly through: number;
}

/** The exchange a committed question belongs to. */
export type Found =
	| { readonly kind: 'closed'; readonly from: number }
	| { readonly kind: 'open'; readonly from: number }
	| { readonly kind: 'outside' };

//@ contract A position is inside a closed range when it lies between its ends.
function inside(range: Range, seq: number): boolean {
	//@ ensures \result <==> (range.from <= seq && seq <= range.through)
	return range.from <= seq && seq <= range.through;
}

//@ contract The exchange a question belongs to: the first close whose range holds it, else the open exchange when the question is at or after its opening, else none.
export function exchangeContaining(
	closes: readonly Range[],
	open: number | undefined,
	seq: number,
): Found {
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

//@ contract The recipient a closing commit names is the owner, or none.
export function addressesOwner(to: string | undefined, owner: string): boolean {
	//@ ensures to == undefined ==> \result
	//@ ensures to != undefined ==> (\result <==> to == owner)
	if (to === undefined) return true;
	return to === owner;
}

/** A person's own presence change. */
export type PresenceKind = 'arrived' | 'left';

/** What a presence or membership change comes to. */
export type Outcome = 'refused' | 'unchanged' | 'written';

//@ contract An agent name cannot arrive. A present person arrives again only under the same identity, and that writes nothing. A departure of an absent person writes nothing. A departure is never refused.
export function presenceOutcome(
	kind: PresenceKind,
	agentName: boolean,
	present: boolean,
	sameIdentity: boolean,
): Outcome {
	//@ ensures kind == 'arrived' && agentName ==> \result == 'refused'
	//@ ensures kind == 'arrived' && !agentName && present && !sameIdentity ==> \result == 'refused'
	//@ ensures kind == 'arrived' && !agentName && present && sameIdentity ==> \result == 'unchanged'
	//@ ensures kind == 'arrived' && !agentName && !present ==> \result == 'written'
	//@ ensures kind == 'left' ==> \result != 'refused'
	//@ ensures kind == 'left' ==> (\result == 'written' <==> present)
	//@ ensures \result == 'written' ==> !agentName || kind == 'left'
	//@ ensures kind == 'arrived' ==> (\result == 'written' <==> !agentName && !present)
	if (kind === 'arrived') {
		if (agentName) return 'refused';
		if (present) return sameIdentity ? 'unchanged' : 'refused';
		return 'written';
	}
	return present ? 'written' : 'unchanged';
}

/** A membership change an activation or the host asks for. */
export type MembershipKind = 'seated' | 'unseated';

//@ contract From an activation: seating a member or unseating a reserve name changes nothing. Seating from the reserve and unseating a member write. Any other name is refused.
export function membershipOutcome(
	kind: MembershipKind,
	onRoster: boolean,
	inReserve: boolean,
): Outcome {
	//@ requires !(onRoster && inReserve)
	//@ ensures kind == 'seated' ==> (\result == 'unchanged' <==> onRoster)
	//@ ensures kind == 'seated' ==> (\result == 'written' <==> inReserve)
	//@ ensures kind == 'unseated' ==> (\result == 'written' <==> onRoster)
	//@ ensures kind == 'unseated' ==> (\result == 'unchanged' <==> inReserve)
	//@ ensures !onRoster && !inReserve ==> \result == 'refused'
	//@ ensures \result == 'refused' <==> (!onRoster && !inReserve)
	if (kind === 'seated') return onRoster ? 'unchanged' : inReserve ? 'written' : 'refused';
	return onRoster ? 'written' : inReserve ? 'unchanged' : 'refused';
}

//@ contract From the host: a seating is admitted when the name is neither a member nor a person the record knows; an unseating when the name is a member. An already satisfied request is refused.
export function hostMembership(
	kind: MembershipKind,
	onRoster: boolean,
	isPerson: boolean,
): boolean {
	//@ ensures kind == 'seated' ==> (\result <==> !onRoster && !isPerson)
	//@ ensures kind == 'unseated' ==> (\result <==> onRoster)
	//@ ensures isPerson && kind == 'seated' ==> !\result
	if (kind === 'seated') return !onRoster && !isPerson;
	return onRoster;
}

//@ contract No two names in the list are the same, and a repeated name is found.
export function distinct(names: readonly string[]): boolean {
	//@ ensures \result <==> forall(i, 0 <= i && i < names.length ==> forall(j, 0 <= j && j < i ==> names[i] != names[j]))
	for (let i = 0; i < names.length; i++) {
		//@ invariant 0 <= i && i <= names.length
		//@ invariant forall(a, 0 <= a && a < i ==> forall(b, 0 <= b && b < a ==> names[a] != names[b]))
		for (let j = 0; j < i; j++) {
			//@ invariant 0 <= j && j <= i
			//@ invariant forall(b, 0 <= b && b < j ==> names[i] != names[b])
			if (names[i] === names[j]) return false;
		}
	}
	return true;
}

/** What the room answers a commit about its lease and grant. */
export type Authority = 'stale' | 'refused' | 'granted';

//@ contract A commit lands only under a lease the fold holds as running and not past its expiry, and only with a room grant. A missing, ended, or expired lease reads as stale; a live lease without a grant as refused.
export function commitAuthority(
	known: LeasePhase | undefined,
	pastExpiry: boolean,
	granted: boolean,
): Authority {
	//@ ensures known == undefined ==> \result == 'stale'
	//@ ensures known != undefined && known == 'ended' ==> \result == 'stale'
	//@ ensures pastExpiry ==> \result == 'stale'
	//@ ensures known != undefined && known == 'running' && !pastExpiry ==> (\result == 'granted' <==> granted)
	//@ ensures known != undefined && known == 'running' && !pastExpiry ==> (\result == 'refused' <==> !granted)
	//@ ensures \result == 'granted' ==> known != undefined && !pastExpiry && granted
	//@ ensures \result == 'refused' ==> known != undefined && !pastExpiry && !granted
	//@ ensures \result != 'stale' ==> known != undefined && !pastExpiry
	if (known === undefined) return 'stale';
	if (known === 'ended') return 'stale';
	if (pastExpiry) return 'stale';
	return granted ? 'granted' : 'refused';
}
