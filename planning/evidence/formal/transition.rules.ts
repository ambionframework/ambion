/**
 * Prototype: every transition rule of the group, in one file LemmaScript
 * checks. Each body is what `transition.ts`, `answers.ts`, and
 * `room-host.ts` run, or would run, at the call site the report names.
 *
 * The string unions are declared here again, because LemmaScript lowers
 * only the types in its own file.
 */

/** The two phases a lease holds. */
export type LeasePhase = 'running' | 'ended';

/** Why a lease ended. The same union as `EndReason` in `types.ts`. */
export type LeaseEndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** What an activation is for: an answer to a message, or a closing summary. */
export type Purpose = 'respond' | 'summarize';

/** What a commit asks for. */
export type Intent = 'said' | 'seated' | 'unseated';

// -- the clock ----------------------------------------------------------------

//@ contract A lease is past its expiry once now reaches it.
export function expired(expiry: number, now: number): boolean {
	//@ ensures \result <==> expiry <= now
	return expiry <= now;
}

// -- say-lock-freshness -------------------------------------------------------

/** What a spoken commit's read position says: off the record, short of it, or at its end. */
export type Freshness = 'invalid' | 'missed' | 'fresh';

//@ contract A position is on the record when it is between zero and the last seq.
export function onRecord(position: number, lastSeq: number): boolean {
	//@ requires lastSeq >= 0
	//@ ensures \result <==> (0 <= position && position <= lastSeq)
	return position >= 0 && position <= lastSeq;
}

//@ contract The say lock: an ordinary spoken commit lands only at the record's last seq. A position on the record short of it missed what landed after it. A position off the record, or none, is invalid.
export function speechFreshness(readThrough: number | undefined, lastSeq: number): Freshness {
	//@ requires lastSeq >= 0
	//@ ensures readThrough == undefined ==> \result == 'invalid'
	//@ ensures readThrough != undefined ==> (\result == 'invalid' <==> !onRecord(readThrough, lastSeq))
	//@ ensures readThrough != undefined ==> (\result == 'fresh' <==> readThrough == lastSeq)
	//@ ensures readThrough != undefined ==> (\result == 'missed' <==> (0 <= readThrough && readThrough < lastSeq))
	//@ ensures \result == 'missed' ==> lastSeq > 0
	//@ ensures \result != 'invalid' ==> readThrough != undefined
	//@ ensures readThrough != undefined && \result == 'fresh' ==> onRecord(readThrough, lastSeq)
	if (readThrough === undefined || !onRecord(readThrough, lastSeq)) return 'invalid';
	return readThrough < lastSeq ? 'missed' : 'fresh';
}

//@ contract A renewal or a release that states a position states one on the record. One that states none is accepted.
export function progressValid(readThrough: number | undefined, lastSeq: number): boolean {
	//@ requires lastSeq >= 0
	//@ ensures readThrough == undefined ==> \result
	//@ ensures readThrough != undefined ==> (\result <==> onRecord(readThrough, lastSeq))
	if (readThrough === undefined) return true;
	return onRecord(readThrough, lastSeq);
}

// -- lease-expiry-deadline ----------------------------------------------------

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
	//@ ensures !expired(claimedAt + deadline, now) ==> !expired(\result, now)
	return Math.min(now + expiry, claimedAt + deadline);
}

// -- lease-admission-one-per-seat ---------------------------------------------

/** Which lease command asks to run. */
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

// -- may-end-state-machine ----------------------------------------------------

//@ contract Ended is final. An activation that never claimed ends only by revocation or abandonment. Abandonment never ends a claimed lease. A running lease is revoked at will, ends as expired only past its expiry, and as released or failed only before it.
export function mayEnd(
	known: LeasePhase | undefined,
	reason: LeaseEndReason,
	pastExpiry: boolean,
): boolean {
	//@ requires known == undefined ==> !pastExpiry
	//@ requires known != undefined && known == 'ended' ==> !pastExpiry
	//@ ensures known == undefined ==> (\result <==> (reason == 'revoked' || reason == 'abandoned'))
	//@ ensures known != undefined && known == 'ended' ==> !\result
	//@ ensures reason == 'abandoned' && known != undefined ==> !\result
	//@ ensures known != undefined && known == 'running' && reason == 'revoked' ==> \result
	//@ ensures known != undefined && known == 'running' && reason == 'expired' ==> (\result <==> pastExpiry)
	//@ ensures known != undefined && known == 'running' && reason == 'released' ==> (\result <==> !pastExpiry)
	//@ ensures known != undefined && known == 'running' && reason == 'failed' ==> (\result <==> !pastExpiry)
	//@ ensures reason == 'revoked' && known == undefined ==> \result
	//@ ensures \result && pastExpiry ==> reason == 'revoked' || reason == 'expired'
	if (known === undefined) return reason === 'revoked' || reason === 'abandoned';
	if (known === 'ended' || reason === 'abandoned') return false;
	if (reason === 'revoked') return true;
	return pastExpiry === (reason === 'expired');
}

// -- permits-purpose-intent ---------------------------------------------------

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

// -- close-admission ----------------------------------------------------------

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

//@ contract A close is admitted when it names the open exchange by owner and opening question, its boundary is the record's last seq, and no exchange work is live. No open exchange admits no close.
export function admitsClose(
	open: OpenExchange | undefined,
	close: CloseRef,
	lastSeq: number,
	exchangeLive: boolean,
): boolean {
	//@ ensures \result ==> open != undefined
	//@ ensures open != undefined && \result ==> open.from == close.from && open.owner == close.owner
	//@ ensures \result ==> close.through == lastSeq
	//@ ensures \result ==> !exchangeLive
	//@ ensures open == undefined ==> !\result
	//@ ensures open != undefined && open.from == close.from && open.owner == close.owner && close.through == lastSeq && !exchangeLive ==> \result
	//@ ensures exchangeLive ==> !\result
	if (open === undefined) return false;
	return (
		open.from === close.from &&
		open.owner === close.owner &&
		close.through === lastSeq &&
		!exchangeLive
	);
}

// -- summary-covers-once ------------------------------------------------------

/** An inclusive range of record positions. */
export interface Range {
	readonly from: number;
	readonly through: number;
}

/** What a closing commit stamps: the recipient and the covered range. */
export interface Stamped {
	readonly to: string;
	readonly covers: Range;
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

// -- presence-arrival-departure -----------------------------------------------

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

// -- membership-outcome -------------------------------------------------------

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
export function hostMembership(kind: MembershipKind, onRoster: boolean, isPerson: boolean): boolean {
	//@ ensures kind == 'seated' ==> (\result <==> !onRoster && !isPerson)
	//@ ensures kind == 'unseated' ==> (\result <==> onRoster)
	//@ ensures isPerson && kind == 'seated' ==> !\result
	if (kind === 'seated') return !onRoster && !isPerson;
	return onRoster;
}

// -- address-reachability -----------------------------------------------------

/** What wakes a seat. The same union as `Attention` in `types.ts`. */
export type Attention = 'none' | 'named' | 'broadcast' | 'presence';

/** Why a directed message reaches its name, or does not. */
export type Address = 'ok' | 'unknown' | 'self' | 'unreachable';

//@ contract A directed message reaches a known name other than the author. A seat that wakes for nothing said is unreachable. An undirected message is always addressable.
export function addressOutcome(
	directed: boolean,
	known: boolean,
	self: boolean,
	seatAttention: Attention | undefined,
): Address {
	//@ requires seatAttention != undefined ==> known
	//@ ensures !directed ==> \result == 'ok'
	//@ ensures directed && !known ==> \result == 'unknown'
	//@ ensures directed && known && self ==> \result == 'self'
	//@ ensures directed && known && !self && seatAttention != undefined && seatAttention == 'none' ==> \result == 'unreachable'
	//@ ensures directed && known && !self && seatAttention == undefined ==> \result == 'ok'
	//@ ensures directed && known && !self && seatAttention != undefined && seatAttention != 'none' ==> \result == 'ok'
	//@ ensures \result == 'ok' && directed ==> known && !self
	//@ ensures \result == 'ok' && directed && seatAttention != undefined ==> seatAttention != 'none'
	if (!directed) return 'ok';
	if (!known) return 'unknown';
	if (self) return 'self';
	if (seatAttention !== undefined && seatAttention === 'none') return 'unreachable';
	return 'ok';
}

// -- acknowledgment-monotone --------------------------------------------------

//@ contract The acknowledged position never moves back: a claim, and a renewal that states nothing, keep the prior acknowledgment. The result is one of the two.
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

// -- composition-admission ----------------------------------------------------

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

// -- commit-authority-live-lease ----------------------------------------------

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

// -- retry-key-match ----------------------------------------------------------

/** The kinds a recorded message has. The same union as `Message['kind']` in `types.ts`. */
export type MessageKind = 'said' | 'arrived' | 'left' | 'seated' | 'unseated' | 'summary';

/** A recorded message, as a retry reads it. `text` is empty for a presence change. */
export interface Recorded {
	readonly kind: MessageKind;
	readonly from: string | undefined;
	readonly to: string | undefined;
	readonly text: string;
	readonly subject: string | undefined;
	readonly activationId: string | undefined;
}

/** What a repeated commit asked for, without the recipient a say names. */
export type Contribution =
	| { kind: 'said'; text: string }
	| { kind: 'seated'; name: string }
	| { kind: 'unseated'; name: string };

//@ contract Two optional names agree when both are absent, or both are present and equal.
export function sameName(a: string | undefined, b: string | undefined): boolean {
	//@ ensures a == undefined && b == undefined ==> \result
	//@ ensures a == undefined && b != undefined ==> !\result
	//@ ensures a != undefined && b == undefined ==> !\result
	//@ ensures a != undefined && b != undefined ==> (\result <==> a == b)
	if (a === undefined) return b === undefined;
	if (b === undefined) return false;
	return a === b;
}

//@ contract An optional name names a name when it is present and equal.
export function namedAs(optional: string | undefined, name: string): boolean {
	//@ ensures optional == undefined ==> !\result
	//@ ensures optional != undefined ==> (\result <==> optional == name)
	if (optional === undefined) return false;
	return optional === name;
}

//@ contract A recorded message answers a person's repeated delivery exactly when it is that person's say, with the same recipient or none in both, the same text, and no activation wrote it.
export function deliveryMatches(
	from: string,
	to: string | undefined,
	text: string,
	message: Recorded,
): boolean {
	//@ ensures \result <==> (message.kind == 'said' && message.activationId == undefined && namedAs(message.from, from) && sameName(message.to, to) && message.text == text)
	//@ ensures \result ==> message.kind == 'said'
	//@ ensures \result ==> message.activationId == undefined
	//@ ensures message.activationId != undefined ==> !\result
	if (message.kind !== 'said') return false;
	if (message.activationId !== undefined) return false;
	if (!namedAs(message.from, from)) return false;
	return sameName(message.to, to) && message.text === text;
}

//@ contract The recorded message is the membership change the intent names.
export function sameMembership(
	kind: MessageKind,
	subject: string | undefined,
	intentKind: MessageKind,
	name: string,
): boolean {
	//@ ensures \result <==> (kind == intentKind && namedAs(subject, name))
	return kind === intentKind && namedAs(subject, name);
}

//@ contract A recorded message answers a repeated commit only under the same activation and seat, and then exactly when it is the same contribution: the same membership change, the same say to the same recipient, or a summary with the same text that addresses the recipient the commit names when it names one.
export function contributionMatches(
	activation: string,
	seat: string,
	intent: Contribution,
	to: string | undefined,
	message: Recorded,
): boolean {
	//@ ensures \result ==> namedAs(message.activationId, activation)
	//@ ensures \result ==> namedAs(message.from, seat)
	//@ ensures message.activationId == undefined ==> !\result
	//@ ensures message.kind == 'arrived' || message.kind == 'left' ==> !\result
	//@ ensures intent.kind == 'seated' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.kind == 'seated' && namedAs(message.subject, intent.name)))
	//@ ensures intent.kind == 'unseated' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.kind == 'unseated' && namedAs(message.subject, intent.name)))
	//@ ensures intent.kind == 'said' && message.kind == 'said' ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && sameName(message.to, to) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind == 'summary' && to == undefined ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind == 'summary' && to != undefined ==> (\result <==> (namedAs(message.activationId, activation) && namedAs(message.from, seat) && namedAs(message.to, to) && message.text == intent.text))
	//@ ensures intent.kind == 'said' && message.kind != 'said' && message.kind != 'summary' ==> !\result
	//@ ensures \result && intent.kind == 'said' ==> message.text == intent.text
	if (!namedAs(message.activationId, activation)) return false;
	if (!namedAs(message.from, seat)) return false;
	if (intent.kind === 'seated') return sameMembership(message.kind, message.subject, 'seated', intent.name);
	if (intent.kind === 'unseated')
		return sameMembership(message.kind, message.subject, 'unseated', intent.name);
	if (message.kind === 'said') return sameName(message.to, to) && message.text === intent.text;
	if (message.kind !== 'summary') return false;
	if (to !== undefined && !namedAs(message.to, to)) return false;
	return message.text === intent.text;
}
