/**
 * Prototype of the reconcile group of rules, for
 * `packages/ambion/src/room/rules.verified.ts`. The first block copies the
 * rules that file already holds and that the new ones name in a contract:
 * `expired`, `mayEnd`, `admitsClose`. Everything after it is new.
 */

/** The two phases a lease holds. */
export type LeasePhase = 'running' | 'ended';

/** Why a lease ended. The same union as `EndReason` in `types.ts`. */
export type LeaseEndReason = 'released' | 'failed' | 'revoked' | 'expired' | 'abandoned';

/** What caused an activation. The same union as `ActivationSource` in `activation-id.ts`. */
export type Source = 'message' | 'closed';

/** How a running lease ends in one pass, or that it stays. */
export type Ending = 'revoked' | 'expired' | 'stays';

// ---- Already in rules.verified.ts -------------------------------------------

//@ contract A lease is past its expiry once now reaches it.
export function expired(expiry: number, now: number): boolean {
	//@ ensures \result <==> expiry <= now
	return expiry <= now;
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

// ---- wake-wait-arithmetic ---------------------------------------------------

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
export function waitsUntil(
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

// ---- alarm-earliest-future --------------------------------------------------

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

// ---- revoke-before-expire ---------------------------------------------------

//@ contract A removal that landed after the cause makes the cause stale.
export function removedAfter(removalSeq: number, position: number): boolean {
	//@ ensures \result <==> removalSeq > position
	return removalSeq > position;
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

// ---- settled-before-close ---------------------------------------------------

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

// ---- close-lands-where-decided ----------------------------------------------

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

// ---- forget-list ------------------------------------------------------------

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

// ---- summary-assignment -----------------------------------------------------

//@ contract A close names the configured summary writer only when that writer is seated at the close.
export function namesWriter(configured: boolean, seated: boolean): boolean {
	//@ ensures \result ==> configured
	//@ ensures \result ==> seated
	//@ ensures configured && seated ==> \result
	return configured && seated;
}

// ---- expired-contract-weak --------------------------------------------------

//@ contract A lease past its expiry stays past it at every later clock reading.
export function stillExpired(expiry: number, now: number, later: number): boolean {
	//@ requires now <= later
	//@ ensures expired(expiry, now) ==> \result
	//@ ensures \result <==> expired(expiry, later)
	return expired(expiry, later);
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

// ---- answered-by-reason -----------------------------------------------------

//@ contract A running lease keeps its cause claimed. An abandoned or revoked lease answers the cause it names. Failed or expired work answers nothing. Anything else answers what its executor read through.
export function answers(
	running: boolean,
	reason: LeaseEndReason,
	atCause: boolean,
	readThrough: number,
	seq: number,
): boolean {
	//@ requires readThrough >= 0
	//@ requires seq >= 1
	//@ ensures running ==> \result
	//@ ensures !running && (reason == 'abandoned' || reason == 'revoked') && atCause ==> \result
	//@ ensures !running && (reason == 'failed' || reason == 'expired') ==> !\result
	//@ ensures !running && reason == 'released' ==> (\result <==> readThrough >= seq)
	//@ ensures !running && (reason == 'abandoned' || reason == 'revoked') && !atCause ==> (\result <==> readThrough >= seq)
	//@ ensures !running && !atCause && readThrough < seq ==> !\result
	if (running) return true;
	if ((reason === 'abandoned' || reason === 'revoked') && atCause) return true;
	if (reason === 'failed' || reason === 'expired') return false;
	return readThrough >= seq;
}

// ---- exchange-live-from-due -------------------------------------------------

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

//@ contract A lease is live while it runs and is not past its expiry. A running lease is live or expired and never both; an ended lease is neither.
export function liveNow(phase: LeasePhase, expiresAt: number, now: number): boolean {
	//@ ensures \result <==> (phase == 'running' && !expired(expiresAt, now))
	//@ ensures phase == 'ended' ==> !\result
	//@ ensures phase == 'running' ==> (\result <==> now < expiresAt)
	return phase === 'running' && !expired(expiresAt, now);
}

//@ contract An activation holds an exchange open when a message caused it. A close causes none that does.
export function holdsExchange(source: Source): boolean {
	//@ ensures \result <==> source == 'message'
	return source === 'message';
}

//@ contract The exchange's own work is live when a live lease a message caused exists, or the room owes an activation a message caused: through its backoff, and at the cap until the abandonment lands.
export function exchangeLive(
	leases: readonly LiveLease[],
	due: readonly OwedActivation[],
	now: number,
): boolean {
	//@ ensures \result <==> (exists(i, 0 <= i && i < leases.length && liveNow(leases[i].phase, leases[i].expiresAt, now) && holdsExchange(leases[i].source)) || exists(j, 0 <= j && j < due.length && holdsExchange(due[j].source)))
	//@ ensures forall(i, 0 <= i && i < leases.length ==> leases[i].source == 'closed') && forall(j, 0 <= j && j < due.length ==> due[j].source == 'closed') ==> !\result
	//@ ensures exists(j, 0 <= j && j < due.length && due[j].source == 'message') ==> \result
	//@ ensures forall(i, 0 <= i && i < leases.length ==> !liveNow(leases[i].phase, leases[i].expiresAt, now)) && due.length == 0 ==> !\result
	//@ ensures leases.length == 0 && due.length == 0 ==> !\result
	return (
		leases.some((lease) => liveNow(lease.phase, lease.expiresAt, now) && holdsExchange(lease.source)) ||
		due.some((owed) => holdsExchange(owed.source))
	);
}

//@ contract A seat is live when it holds a live lease or the room owes it an activation.
export function seatLive(
	leases: readonly LiveLease[],
	due: readonly OwedActivation[],
	now: number,
	seat: string,
): boolean {
	//@ ensures \result <==> (exists(i, 0 <= i && i < leases.length && leases[i].seat == seat && liveNow(leases[i].phase, leases[i].expiresAt, now)) || exists(j, 0 <= j && j < due.length && due[j].seat == seat))
	//@ ensures leases.length == 0 && due.length == 0 ==> !\result
	return (
		leases.some((lease) => lease.seat === seat && liveNow(lease.phase, lease.expiresAt, now)) ||
		due.some((owed) => owed.seat === seat)
	);
}
