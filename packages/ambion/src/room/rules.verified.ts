/**
 * The rules the room decides by, as functions LemmaScript checks. Every
 * function here is pure, and `lease.ts`, `reconcile.ts`, `delivery.ts`,
 * and `transition.ts` run these bodies: the proof is about the code the
 * room runs. `lsc check` turns the `//@` annotations into Dafny
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
export function expired(expiry: number, now: number): boolean {
	//@ ensures \result <==> expiry <= now
	return expiry <= now;
}

//@ contract A lease was at work when a message landed: it held a change before the message, and ended, if it ended, after it.
export function atWork(since: number, ended: boolean, until: number, seq: number): boolean {
	//@ ensures \result ==> since < seq
	//@ ensures \result && ended ==> until >= seq
	//@ ensures !ended ==> (\result <==> since < seq)
	return since < seq && (!ended || until >= seq);
}

//@ contract A lease covers an entry while it attempts work.
export function coversAttempt(ended: boolean, until: number, seq: number): boolean {
	//@ ensures !ended ==> \result
	//@ ensures ended ==> (\result <==> seq <= until)
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
export function nextAttempt(attempts: number): number {
	//@ requires attempts >= 0
	//@ ensures \result == attempts + 1
	//@ ensures \result >= 1
	return attempts + 1;
}

//@ contract A cause before a cancellation marker belongs to cancelled work.
export function beforeCancellation(position: number, cancelledAt: number): boolean {
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
