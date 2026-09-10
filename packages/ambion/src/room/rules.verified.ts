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

//@ contract A lease was at work when a message landed: it held a row before the message, and ended, if it ended, after it.
export function atWork(since: number, ended: boolean, until: number, seq: number): boolean {
	//@ ensures \result ==> since < seq
	//@ ensures \result && ended ==> until >= seq
	//@ ensures !ended ==> (\result <==> since < seq)
	return since < seq && (!ended || until >= seq);
}

//@ contract A lease heard a message. One that runs or came to nothing heard what it was at work for and what its view held; one that stood down heard through the seq its last renewal confirmed.
export function heard(
	liveOrFailed: boolean,
	since: number,
	ended: boolean,
	until: number,
	heardThrough: number,
	seq: number,
): boolean {
	//@ requires heardThrough >= since
	//@ ensures !liveOrFailed ==> (\result <==> seq <= heardThrough)
	//@ ensures liveOrFailed && since >= seq ==> \result
	//@ ensures liveOrFailed && !ended && since < seq ==> \result
	//@ ensures !liveOrFailed && seq > heardThrough ==> !\result
	if (liveOrFailed) return atWork(since, ended, until, seq) || since >= seq;
	return seq <= heardThrough;
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
