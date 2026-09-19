// Hand-written proofs over the generated rules. `check-extra.sh` verifies this file.
include "rules.verified.dfy"
// ---- Proof additions (hand-written, additions-only) ----------------------

// One stored entry as the fence reads it: whether it is a run entry, and who wrote it.
datatype Stamped = Stamped(isRun: bool, writer: Option<string>)

// The fence over a whole read: fenceStep folded over the stored entries in order.
function fenceFold(state: Fence, own: Option<string>, entries: seq<Stamped>): Fence
  decreases |entries|
{
  if |entries| == 0 then state
  else fenceFold(fenceStep(state, own, entries[0].isRun, entries[0].writer).state, own, entries[1..])
}

// Superseded is absorbing over any read.
lemma SupersededIsAbsorbing(state: Fence, own: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  ensures state.superseded ==> fenceFold(state, own, entries).superseded
{
  if |entries| > 0 {
    var next := fenceStep(state, own, entries[0].isRun, entries[0].writer).state;
    fenceStep_ensures(state, own, entries[0].isRun, entries[0].writer);
    SupersededIsAbsorbing(next, own, entries[1..]);
  }
}

// Fenced is absorbing over any read.
lemma FencedIsAbsorbing(state: Fence, own: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  ensures state.fenced ==> fenceFold(state, own, entries).fenced
{
  if |entries| > 0 {
    var next := fenceStep(state, own, entries[0].isRun, entries[0].writer).state;
    fenceStep_ensures(state, own, entries[0].isRun, entries[0].writer);
    FencedIsAbsorbing(next, own, entries[1..]);
  }
}

// A read that passes no run entry leaves the fence where it stood.
lemma NoRunEntryKeepsFence(state: Fence, own: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  requires forall k :: 0 <= k < |entries| ==> !entries[k].isRun
  ensures fenceFold(state, own, entries) == state
{
  if |entries| > 0 {
    fenceStep_ensures(state, own, entries[0].isRun, entries[0].writer);
    NoRunEntryKeepsFence(state, own, entries[1..]);
  }
}

// Before any run entry, every entry is kept.
lemma BeforeFirstFenceEverythingKept(state: Fence, own: Option<string>, entries: seq<Stamped>, k: int)
  requires state.fence == None
  requires forall j :: 0 <= j < |entries| ==> !entries[j].isRun
  requires 0 <= k < |entries|
  ensures fenceStep(fenceFold(state, own, entries[..k]), own, entries[k].isRun, entries[k].writer).keep
{
  NoRunEntryKeepsFence(state, own, entries[..k]);
  fenceStep_ensures(state, own, entries[k].isRun, entries[k].writer);
}

// A journal that never sees its own run entry is never superseded, whatever the read holds.
lemma NeverFencedNeverSuperseded(state: Fence, own: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  requires !state.fenced && !state.superseded
  requires forall j :: 0 <= j < |entries| ==> !(entries[j].isRun && sameWriter(own, entries[j].writer))
  ensures !fenceFold(state, own, entries).superseded
  ensures !fenceFold(state, own, entries).fenced
{
  if |entries| > 0 {
    var next := fenceStep(state, own, entries[0].isRun, entries[0].writer).state;
    fenceStep_ensures(state, own, entries[0].isRun, entries[0].writer);
    NeverFencedNeverSuperseded(next, own, entries[1..]);
  }
}

// How many steps of a read tell the caller `lost`.
function lostCount(state: Fence, own: Option<string>, entries: seq<Stamped>): nat
  decreases |entries|
{
  if |entries| == 0 then 0
  else
    var passed := fenceStep(state, own, entries[0].isRun, entries[0].writer);
    (if passed.lost then 1 else 0) + lostCount(passed.state, own, entries[1..])
}

// The caller hears `lost` at most once over any read, and never once superseded.
lemma LostAtMostOnce(state: Fence, own: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  ensures state.superseded ==> lostCount(state, own, entries) == 0
  ensures lostCount(state, own, entries) <= 1
{
  if |entries| > 0 {
    var passed := fenceStep(state, own, entries[0].isRun, entries[0].writer);
    fenceStep_ensures(state, own, entries[0].isRun, entries[0].writer);
    LostAtMostOnce(passed.state, own, entries[1..]);
  }
}

// A journal with no run reads the fence like any other reader: it is never
// fenced, never superseded, and never hears `lost`, whatever the read holds.
lemma NoRunReadsLikeAnyReader(state: Fence, entries: seq<Stamped>)
  decreases |entries|
  requires !state.fenced && !state.superseded
  ensures !fenceFold(state, None, entries).fenced
  ensures !fenceFold(state, None, entries).superseded
  ensures lostCount(state, None, entries) == 0
{
  if |entries| > 0 {
    var passed := fenceStep(state, None, entries[0].isRun, entries[0].writer);
    fenceStep_ensures(state, None, entries[0].isRun, entries[0].writer);
    NoRunReadsLikeAnyReader(passed.state, entries[1..]);
  }
}

// After the fence of run r, a kept stamped entry that is not a run entry is r's.
lemma KeptAfterFenceIsTheFencesRun(state: Fence, own: Option<string>, writer: string, r: string)
  requires state.fence == Some(r)
  ensures fenceStep(state, own, false, Some(writer)).keep ==> writer == r
{
  fenceStep_ensures(state, own, false, Some(writer));
}

// Own fence, then another run's fence: superseded, and lost at exactly that step.
lemma OwnThenOtherSupersedes(state: Fence, own: string, other: string)
  requires own != other
  requires !state.superseded
  ensures fenceStep(fenceStep(state, Some(own), true, Some(own)).state, Some(own), true, Some(other)).state.superseded
  ensures fenceStep(fenceStep(state, Some(own), true, Some(own)).state, Some(own), true, Some(other)).lost
{
  var afterOwn := fenceStep(state, Some(own), true, Some(own)).state;
  fenceStep_ensures(state, Some(own), true, Some(own));
  sameWriter_ensures(Some(own), Some(own));
  sameWriter_ensures(Some(own), Some(other));
  fenceStep_ensures(afterOwn, Some(own), true, Some(other));
}

// Which entries a step keeps, and where the fence moves, never depend on
// who reads: two readers at the same fence keep the same entry.
lemma KeepIgnoresReader(state: Fence, a: Option<string>, b: Option<string>, isRun: bool, writer: Option<string>)
  ensures fenceStep(state, a, isRun, writer).keep == fenceStep(state, b, isRun, writer).keep
  ensures fenceStep(state, a, isRun, writer).state.fence == fenceStep(state, b, isRun, writer).state.fence
{
  fenceStep_ensures(state, a, isRun, writer);
  fenceStep_ensures(state, b, isRun, writer);
}

// Over a whole read, the fence two readers arrive at is the same when they
// started at the same fence, so the entries they keep are the same.
lemma FenceIgnoresReader(s: Fence, t: Fence, a: Option<string>, b: Option<string>, entries: seq<Stamped>)
  decreases |entries|
  requires s.fence == t.fence
  ensures fenceFold(s, a, entries).fence == fenceFold(t, b, entries).fence
{
  if |entries| > 0 {
    var ns := fenceStep(s, a, entries[0].isRun, entries[0].writer).state;
    var nt := fenceStep(t, b, entries[0].isRun, entries[0].writer).state;
    fenceStep_ensures(s, a, entries[0].isRun, entries[0].writer);
    fenceStep_ensures(t, b, entries[0].isRun, entries[0].writer);
    FenceIgnoresReader(ns, nt, a, b, entries[1..]);
  }
}

// A writable journal appends an entry every reader at the same fence keeps:
// the pure half of "every entry this journal appends, every reader keeps".
lemma WritableIsKeptByEveryReader(closed: bool, state: Fence, own: Option<string>, isRun: bool, reader: Option<string>)
  ensures writable(closed, state, own, isRun) ==> fenceStep(state, reader, isRun, own).keep
{
  writable_ensures(closed, state, own, isRun);
  KeepIgnoresReader(state, own, reader, isRun, own);
}

// The last seq the journal gives out: below the largest safe integer, so
// the successor of every cached seq is exact in a double.
const LAST_SEQ: int := 9007199254740990

// The seq counter over a cache, folded the way `remember` runs `advanceSeq`.
// Every cached seq is at most LAST_SEQ, because `positionOf` takes no other.
function counterFrom(start: int, seqs: seq<int>): int
  requires 0 <= start <= LAST_SEQ
  requires forall k :: 0 <= k < |seqs| ==> 0 <= seqs[k] <= LAST_SEQ
  decreases |seqs|
{
  if |seqs| == 0 then start else counterFrom(advanceSeq(start, seqs[0]), seqs[1..])
}

// The counter is at least every cached seq, so the next seq is one no cached
// entry holds. The journal refuses a write once the counter reaches LAST_SEQ.
lemma CounterCoversCache(start: int, seqs: seq<int>)
  requires 0 <= start <= LAST_SEQ
  requires forall k :: 0 <= k < |seqs| ==> 0 <= seqs[k] <= LAST_SEQ
  decreases |seqs|
  ensures counterFrom(start, seqs) >= start
  ensures 0 <= counterFrom(start, seqs) <= LAST_SEQ
  ensures forall k :: 0 <= k < |seqs| ==> counterFrom(start, seqs) >= seqs[k]
  ensures counterFrom(start, seqs) < LAST_SEQ ==>
    forall k :: 0 <= k < |seqs| ==> nextSeq(counterFrom(start, seqs)) > seqs[k]
{
  if |seqs| > 0 {
    advanceSeq_ensures(start, seqs[0]);
    CounterCoversCache(advanceSeq(start, seqs[0]), seqs[1..]);
  }
  if counterFrom(start, seqs) < LAST_SEQ {
    nextSeq_ensures(counterFrom(start, seqs));
  }
}

// The cursor over one read, folded the way `read` runs `scanned`.
function cursorFold(cursor: int, positions: seq<int>): int
  requires cursor >= 0
  requires forall k :: 0 <= k < |positions| ==> positions[k] >= 0
  decreases |positions|
{
  if |positions| == 0 then cursor else cursorFold(scanned(cursor, positions[0]), positions[1..])
}

// The cursor after a read is at least where it stood and at least every position scanned.
lemma CursorNeverMovesBack(cursor: int, positions: seq<int>)
  requires cursor >= 0
  requires forall k :: 0 <= k < |positions| ==> positions[k] >= 0
  decreases |positions|
  ensures cursorFold(cursor, positions) >= cursor
  ensures forall k :: 0 <= k < |positions| ==> cursorFold(cursor, positions) >= positions[k]
{
  if |positions| > 0 {
    scanned_ensures(cursor, positions[0]);
    CursorNeverMovesBack(scanned(cursor, positions[0]), positions[1..]);
  }
}
