/**
 * The rules the journal writes by, as functions LemmaScript checks. Every
 * function here is pure, and `journal.ts`, `memory.ts`, and `sqlite.ts`
 * run these bodies: the proof is about the code the journal runs. `lsc
 * check` turns the `//@` annotations into Dafny obligations, and CI
 * verifies them. `rules.verified.dfy` carries the lemmas over a whole
 * read that the generator cannot write: superseded is absorbing, `lost`
 * fires at most once, a journal with no run is never fenced, the counter
 * covers every cached seq, and the cursor never moves back.
 */

/** The fence as one read leaves it: whose run entry stands, and what this run has met. */
export interface Fence {
	/** The run whose entry the read passed last, or nothing before the first run entry. */
	readonly fence: string | undefined;
	/** This run's own entry is on the journal. */
	readonly fenced: boolean;
	/** A later run's entry was found after this run's own: this run writes nothing more. */
	readonly superseded: boolean;
}

/** One stored entry through the fence: the fence after it, and what to do with the entry. */
export interface Passed {
	readonly state: Fence;
	/** The entry is one this journal takes. */
	readonly keep: boolean;
	/** This step supersedes the journal, and the caller hears it once. */
	readonly lost: boolean;
}

/** The entry a key already names, as the key decision reads it. */
export interface Seen {
	readonly kind: string;
	readonly run: string | undefined;
}

/** What a key decides: the decision runs, the first entry answers, or the append fails. */
export type Keyed = 'fresh' | 'replay' | 'conflict';

//@ contract Two writers are the same run when both are named and the names agree. A journal with no run is nobody's run.
function sameWriter(own: string | undefined, writer: string | undefined): boolean {
	//@ ensures own == undefined ==> !\result
	//@ ensures writer == undefined ==> !\result
	//@ ensures own != undefined && writer != undefined ==> (\result <==> own == writer)
	return own !== undefined && writer !== undefined && own === writer;
}

//@ contract The next entry of any kind takes the seq after the last one the journal gave out. A seq is a double, so the last one stays below the largest safe integer and its successor is exact.
export function nextSeq(lastSeq: number): number {
	//@ requires lastSeq >= 0
	//@ requires lastSeq < 9007199254740990
	//@ ensures \result == lastSeq + 1
	//@ ensures \result > lastSeq
	//@ ensures \result <= 9007199254740990
	return lastSeq + 1;
}

//@ contract The counter never falls below a seq the journal took, so the next seq is one no cached entry holds.
export function advanceSeq(lastSeq: number, seq: number): number {
	//@ requires lastSeq >= 0
	//@ requires seq >= 0
	//@ requires lastSeq <= 9007199254740990
	//@ requires seq <= 9007199254740990
	//@ ensures \result >= lastSeq
	//@ ensures \result >= seq
	//@ ensures \result == lastSeq || \result == seq
	//@ ensures \result <= 9007199254740990
	//@ ensures \result < 9007199254740990 ==> nextSeq(\result) > seq
	//@ ensures \result < 9007199254740990 ==> nextSeq(\result) > lastSeq
	return Math.max(lastSeq, seq);
}

//@ contract The cursor moves to the highest storage position a read scanned, and never back.
export function scanned(cursor: number, position: number): number {
	//@ requires cursor >= 0
	//@ requires position >= 0
	//@ ensures \result >= cursor
	//@ ensures \result >= position
	//@ ensures \result == cursor || \result == position
	return Math.max(cursor, position);
}

//@ contract A run entry moves the fence to its run. This journal's own run entry marks it fenced. Another run's entry past that supersedes it, once. Superseded is absorbing.
function passFence(state: Fence, own: string | undefined, writer: string | undefined): Passed {
	//@ ensures \result.state.fence == writer
	//@ ensures \result.keep
	//@ ensures sameWriter(own, writer) ==> \result.state.fenced
	//@ ensures sameWriter(own, writer) ==> \result.state.superseded == state.superseded
	//@ ensures !sameWriter(own, writer) ==> \result.state.fenced == state.fenced
	//@ ensures !sameWriter(own, writer) && state.fenced ==> \result.state.superseded
	//@ ensures state.superseded ==> \result.state.superseded
	//@ ensures state.fenced ==> \result.state.fenced
	//@ ensures !state.superseded && !state.fenced ==> !\result.state.superseded
	//@ ensures \result.lost <==> (!state.superseded && \result.state.superseded)
	if (sameWriter(own, writer)) {
		return {
			state: { fence: writer, fenced: true, superseded: state.superseded },
			keep: true,
			lost: false,
		};
	}
	const superseded = state.superseded || state.fenced;
	return {
		state: { fence: writer, fenced: state.fenced, superseded },
		keep: true,
		lost: superseded && !state.superseded,
	};
}

//@ contract An entry that is not a run entry leaves the fence as it stands. It is void when a fence stands, the entry names its writer, and the writer is another run.
function passEntry(state: Fence, writer: string | undefined): Passed {
	//@ ensures \result.state == state
	//@ ensures !\result.lost
	//@ ensures state.fence == undefined ==> \result.keep
	//@ ensures writer == undefined ==> \result.keep
	//@ ensures state.fence != undefined && writer != undefined ==> (\result.keep <==> state.fence == writer)
	const keep = state.fence === undefined || writer === undefined || writer === state.fence;
	return { state, keep, lost: false };
}

//@ contract One stored entry through the fence: a run entry moves it and is always kept; any other entry is kept unless the fence voids it. A journal with no run is never fenced.
export function fenceStep(
	state: Fence,
	own: string | undefined,
	isRun: boolean,
	writer: string | undefined,
): Passed {
	//@ ensures state.superseded ==> \result.state.superseded
	//@ ensures state.fenced ==> \result.state.fenced
	//@ ensures isRun ==> \result.keep
	//@ ensures isRun ==> \result.state.fence == writer
	//@ ensures !isRun ==> \result.state == state
	//@ ensures !isRun && state.fence != undefined && writer != undefined && writer != state.fence ==> !\result.keep
	//@ ensures !isRun && state.fence != undefined && writer != undefined && writer == state.fence ==> \result.keep
	//@ ensures !isRun && state.fence == undefined ==> \result.keep
	//@ ensures !isRun && writer == undefined ==> \result.keep
	//@ ensures \result.keep && !isRun && state.fence != undefined && writer != undefined ==> writer == state.fence
	//@ ensures \result.lost ==> isRun
	//@ ensures \result.lost ==> !state.superseded && \result.state.superseded
	//@ ensures isRun && sameWriter(own, writer) ==> \result.state.fenced
	//@ ensures isRun && sameWriter(own, writer) ==> \result.state.superseded == state.superseded
	//@ ensures isRun && !sameWriter(own, writer) && state.fenced ==> \result.state.superseded
	//@ ensures isRun && !sameWriter(own, writer) && state.fenced && !state.superseded ==> \result.lost
	//@ ensures !state.fenced && !(isRun && sameWriter(own, writer)) ==> \result.state.fenced == false
	//@ ensures !state.fenced && !state.superseded ==> !\result.state.superseded
	//@ ensures own == undefined && !state.fenced ==> !\result.state.fenced
	//@ ensures own == undefined && !state.fenced && !state.superseded ==> !\result.state.superseded && !\result.lost
	return isRun ? passFence(state, own, writer) : passEntry(state, writer);
}

//@ contract A key names one entry: an unseen key is fresh, a seen key of the same kind replays that entry, a seen key of another kind conflicts, and a fence key of another writer conflicts.
export function keyed(
	seen: Seen | undefined,
	kind: string,
	fenceKind: string,
	own: string | undefined,
): Keyed {
	//@ ensures seen == undefined ==> \result == 'fresh'
	//@ ensures seen != undefined ==> \result != 'fresh'
	//@ ensures \result == 'fresh' ==> seen == undefined
	//@ ensures seen == undefined ==> \result != 'replay'
	//@ ensures seen != undefined && seen.kind != kind ==> \result != 'replay'
	//@ ensures seen == undefined ==> \result != 'conflict'
	//@ ensures seen != undefined && seen.kind != kind ==> \result == 'conflict'
	//@ ensures seen != undefined && seen.kind == kind && kind != fenceKind ==> \result == 'replay'
	//@ ensures seen != undefined && seen.kind == kind && sameWriter(own, seen.run) ==> \result == 'replay'
	//@ ensures seen != undefined && seen.kind == kind && kind == fenceKind && !sameWriter(own, seen.run) ==> \result == 'conflict'
	if (seen === undefined) return 'fresh';
	if (seen.kind !== kind) return 'conflict';
	if (kind === fenceKind && !sameWriter(own, seen.run)) return 'conflict';
	return 'replay';
}

//@ contract A journal writes while it is neither closed nor superseded, and never an entry its own fence would void.
export function writable(
	closed: boolean,
	state: Fence,
	own: string | undefined,
	isRun: boolean,
): boolean {
	//@ ensures closed ==> !\result
	//@ ensures state.superseded ==> !\result
	//@ ensures \result ==> fenceStep(state, own, isRun, own).keep
	//@ ensures !closed && !state.superseded && fenceStep(state, own, isRun, own).keep ==> \result
	//@ ensures !closed && !state.superseded && isRun ==> \result
	//@ ensures !closed && !state.superseded && own == undefined ==> \result
	//@ ensures !closed && !state.superseded && state.fence == undefined ==> \result
	//@ ensures !closed && !state.superseded && own != undefined && state.fence != undefined && own == state.fence ==> \result
	//@ ensures own != undefined && state.fence != undefined && own != state.fence && !isRun ==> !\result
	return !closed && !state.superseded && fenceStep(state, own, isRun, own).keep;
}
