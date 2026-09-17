/**
 * The rules the room decides by, as functions LemmaScript checks. Every
 * function here is pure, and `lease.ts` and `reconcile.ts` run these
 * bodies: the proof is about the code the room runs. `lsc check` turns
 * the `//@` annotations into Dafny obligations, and CI verifies them.
 */

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

//@ contract A working-room activity watermark has a positive Task idle epoch.
export function taskIdleEpoch(activity: number): number {
	//@ requires activity >= 0
	//@ ensures \result >= 1
	//@ ensures activity >= 1 ==> \result == activity
	return activity < 1 ? 1 : activity;
}

//@ contract An open, quiet Task requests intervention only without a pending delivery or prior idle event.
export function shouldRequestTaskIdle(
	open: boolean,
	quiet: boolean,
	pendingDelivery: boolean,
	hasSameEpoch: boolean,
): boolean {
	//@ ensures \result <==> (open && quiet && !pendingDelivery && !hasSameEpoch)
	return open && quiet && !pendingDelivery && !hasSameEpoch;
}

//@ contract A Task is created only in its originating room while its exchange is open.
export function taskCanCreate(origin: boolean, exchangeOpen: boolean): boolean {
	//@ ensures \result <==> (origin && exchangeOpen)
	return origin && exchangeOpen;
}

//@ contract A Task mutation belongs to its owner in the origin or to a worker in the working room.
export function taskCanMutate(
	origin: boolean,
	owner: boolean,
	working: boolean,
	steering: boolean,
): boolean {
	//@ ensures \result <==> ((origin && owner) || (working && !steering))
	return (origin && owner) || (working && !steering);
}

//@ contract A Task terminal state is immutable after the first accepted operation, except when replaying that operation.
export function taskCanTransition(open: boolean, replay: boolean): boolean {
	//@ ensures \result <==> (open || replay)
	return open || replay;
}
