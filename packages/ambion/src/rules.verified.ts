/**
 * The rules the vocabulary decides by, as functions LemmaScript checks.
 * `journal/validate.ts` and `activation-id.ts` run these bodies. Both sit
 * below the room, so the room's rules file cannot hold them.
 */

//@ contract A range on the record starts at the first entry or later and ends where it starts or later.
export function rangeWellFormed(from: number, through: number): boolean {
	//@ ensures \result <==> (1 <= from && from <= through)
	//@ ensures \result ==> through >= 1
	return from >= 1 && from <= through;
}

//@ contract A position or an attempt is bounded when it is at least one and at most the largest safe integer. Integrality and the string form stay in `activation-id.ts`.
export function positiveBounded(value: number): boolean {
	//@ ensures \result <==> (1 <= value && value <= 9007199254740991)
	return value >= 1 && value <= 9007199254740991;
}

//@ contract A summary stands for a position inside its covered range.
export function coversSeq(summaryFrom: number, summaryThrough: number, seq: number): boolean {
	//@ ensures \result <==> summaryFrom <= seq && seq <= summaryThrough
	return summaryFrom <= seq && seq <= summaryThrough;
}
