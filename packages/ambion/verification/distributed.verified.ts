/**
 * Small executable specifications for the coordinator rules in FINDINGS.md.
 *
 * LemmaScript checks these pure transitions. The network and storage adapters
 * must make each transition one atomic coordinator operation.
 */

//@ contract Allocates the next sequence number from one coordinator snapshot.
export function nextSequence(lastSequence: number): number {
	//@ requires lastSequence >= 0
	//@ ensures \result == lastSequence + 1
	//@ ensures \result > lastSequence
	return lastSequence + 1;
}

//@ contract Shows that two private writers allocate the same sequence from the same snapshot.
export function privateAllocationsCollide(snapshot: number): boolean {
	//@ requires snapshot >= 0
	//@ ensures \result
	const first = nextSequence(snapshot);
	const second = nextSequence(snapshot);
	return first === second;
}

//@ contract Accepts an operation only from the current room generation.
export function acceptsGeneration(current: number, presented: number): boolean {
	//@ requires current >= 1
	//@ requires presented >= 1
	//@ ensures \result <==> current == presented
	return current === presented;
}

//@ contract Keeps an ended lease terminal while later rows fold over it.
export function foldLeaseEnded(knownEnded: boolean, rowEnded: boolean): boolean {
	//@ ensures knownEnded ==> \result
	//@ ensures \result <==> knownEnded || rowEnded
	if (knownEnded) return true;
	return rowEnded;
}

//@ contract Accepts a keyed append only when its generation and cursor are current.
export function acceptsAppend(
	currentGeneration: number,
	presentedGeneration: number,
	lastSequence: number,
	readThrough: number,
	keySeen: boolean,
): boolean {
	//@ requires currentGeneration >= 1
	//@ requires presentedGeneration >= 1
	//@ requires lastSequence >= 0
	//@ requires readThrough >= 0
	//@ ensures \result ==> currentGeneration == presentedGeneration
	//@ ensures \result ==> lastSequence == readThrough
	//@ ensures \result ==> !keySeen
	//@ ensures currentGeneration == presentedGeneration && lastSequence == readThrough && !keySeen ==> \result
	return currentGeneration === presentedGeneration && lastSequence === readThrough && !keySeen;
}
