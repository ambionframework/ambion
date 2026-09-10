/**
 * The rules the log writes by, as functions LemmaScript checks. Every
 * function here is pure, and `log.ts` runs these bodies: the proof is
 * about the code the log runs. `lsc check` turns the `//@` annotations
 * into Dafny obligations, and CI verifies them.
 */

//@ contract The next message takes the seq after the last one the log confirmed.
export function nextSeq(lastSeq: number): number {
	//@ requires lastSeq >= 0
	//@ ensures \result == lastSeq + 1
	//@ ensures \result > lastSeq
	return lastSeq + 1;
}

//@ contract Rule 5: a commit that read through a seq is refused once the record moved past it.
export function refused(lastSeq: number, readThrough: number): boolean {
	//@ requires lastSeq >= 0
	//@ requires readThrough >= 0
	//@ ensures \result <==> lastSeq > readThrough
	//@ ensures !\result ==> readThrough >= lastSeq
	return lastSeq > readThrough;
}

//@ contract An entry is void when a fence stands, the entry names its writer, and the writer is another run.
export function voided(fenced: boolean, stamped: boolean, sameRun: boolean): boolean {
	//@ ensures \result ==> fenced
	//@ ensures \result ==> stamped
	//@ ensures \result ==> !sameRun
	//@ ensures sameRun ==> !\result
	//@ ensures fenced && stamped && !sameRun ==> \result
	return fenced && stamped && !sameRun;
}

//@ contract A run row of another run supersedes this run once this run's own row is on the log.
export function supersedes(ownRowLanded: boolean, sameRun: boolean): boolean {
	//@ ensures \result <==> ownRowLanded && !sameRun
	//@ ensures sameRun ==> !\result
	//@ ensures !ownRowLanded ==> !\result
	return ownRowLanded && !sameRun;
}
