// Hand-written proofs over the generated rules. `check-extra.sh` verifies this file.
include "rules.verified.dfy"


// The attempts at one message cause for one seat, in journal order. `count` is how many
// covering leases the fold counts as unsuccessful (`failed.length` in `statusOf`); `running`
// is the attempt at this cause that holds a running lease; `ended` is every attempt number
// at this cause whose lease ended, for any reason.
datatype AttemptEvent =
  | Claim(attempt: int)      // runningLease admits a first claim of the id the fold owes
  | Written(attempt: int)    // mayEnd(undefined, revoked | abandoned): the owed id ended before it started
  | EndAtCause(attempt: int) // mayEnd(running, reason): the running attempt at this cause ended
  | OtherFailure             // a covering lease of another cause came to nothing
datatype Attempts = Attempts(count: int, running: Option<int>, ended: set<int>)

// What the room admits: a claim or a write-off only of the id the fold owes, while nothing
// at this cause runs; an end only of the running attempt.
predicate attemptAdmitted(s: Attempts, e: AttemptEvent)
  requires s.count >= 0
{
  match e
  case Claim(a) => a == nextAttempt(s.count) && s.running == None
  case Written(a) => a == nextAttempt(s.count) && s.running == None
  case EndAtCause(a) => s.running == Some(a)
  case OtherFailure => true
}

function attemptStep(s: Attempts, e: AttemptEvent): Attempts {
  match e
  case Claim(a) => Attempts(s.count, Some(a), s.ended)
  case Written(a) => Attempts(s.count + 1, None, s.ended + {a})
  case EndAtCause(a) => Attempts(s.count + 1, None, s.ended + {a})
  case OtherFailure => Attempts(s.count + 1, s.running, s.ended)
}

// Every ended attempt is numbered at most `count`, and a running one at most `count + 1`.
predicate attemptsInv(s: Attempts) {
  s.count >= 0
  && (forall a :: a in s.ended ==> a <= s.count)
  && (s.running.Some? ==> s.running.value <= s.count + 1)
}

lemma AttemptStepPreserves(s: Attempts, e: AttemptEvent)
  requires attemptsInv(s) && attemptAdmitted(s, e)
  ensures attemptsInv(attemptStep(s, e))
{ }

// The id the fold derives next names no lease that ended.
lemma NextAttemptIsFresh(s: Attempts)
  requires attemptsInv(s)
  ensures nextAttempt(s.count) !in s.ended
{ }

function attemptFold(s: Attempts, es: seq<AttemptEvent>): Attempts
  decreases |es|
{
  if |es| == 0 then s else attemptFold(attemptStep(s, es[0]), es[1..])
}

predicate attemptsAdmitted(s: Attempts, es: seq<AttemptEvent>)
  requires attemptsInv(s)
  decreases |es|
{
  |es| == 0 || (attemptAdmitted(s, es[0]) && (AttemptStepPreserves(s, es[0]); attemptsAdmitted(attemptStep(s, es[0]), es[1..])))
}

lemma AttemptIdsAreFresh(s: Attempts, es: seq<AttemptEvent>)
  requires attemptsInv(s) && attemptsAdmitted(s, es)
  decreases |es|
  ensures attemptsInv(attemptFold(s, es))
  ensures nextAttempt(attemptFold(s, es).count) !in attemptFold(s, es).ended
{
  if |es| > 0 {
    AttemptStepPreserves(s, es[0]);
    AttemptIdsAreFresh(attemptStep(s, es[0]), es[1..]);
  }
  NextAttemptIsFresh(attemptFold(s, es));
}

// From rest: no lease at this cause, nothing counted.
lemma AttemptIdsAreFreshFromRest(es: seq<AttemptEvent>)
  requires attemptsAdmitted(Attempts(0, None, {}), es)
  ensures attemptsInv(attemptFold(Attempts(0, None, {}), es))
  ensures nextAttempt(attemptFold(Attempts(0, None, {}), es).count) !in attemptFold(Attempts(0, None, {}), es).ended
{
  AttemptIdsAreFresh(Attempts(0, None, {}), es);
}


// ---- The clock only moves forward ------------------------------------------

// A lease past its expiry stays past it at every later clock reading.
lemma StillExpired(expiry: int, now: int, later: int)
  requires now <= later
  ensures expired(expiry, now) ==> expired(expiry, later)
{
}

// An ending the pass decides at one clock reading is one the write accepts at
// every later reading: an expiry stays expired, and a revocation needs no clock.
lemma EndingStands(stale: bool, expiry: int, now: int, later: int)
  requires now <= later
  ensures endingOf(true, stale, expired(expiry, now)) == Ending.expired ==> mayEnd(Some(LeasePhase.running), LeaseEndReason.expired, expired(expiry, later))
  ensures endingOf(true, stale, expired(expiry, now)) == Ending.revoked ==> mayEnd(Some(LeasePhase.running), LeaseEndReason.revoked, expired(expiry, later))
{
  StillExpired(expiry, now, later);
}

// ---- One lease history -----------------------------------------------------

// One entry the fold applies to the lease it holds for one id: a lease change
// at its seq, or a cancellation marker at its seq.
datatype LeaseEvent =
  | Changed(change: Change, seqNo: int)
  | Cancelled(position: int, cancelledAt: int, stamp: string)

// What the fold admits, which are the preconditions of `applyChange` and
// `cancelHold`. A change lands at or after the lease's start with a read
// position of zero or more. A marker lands at or after the lease's start.
predicate leaseAdmits(known: Option<Hold>, e: LeaseEvent) {
  match e
  case Changed(change, seqNo) =>
    seqNo >= 1 && change.readThrough >= 0
    && (known.Some? ==> known.value.readThrough >= 0 && known.value.since <= seqNo)
  case Cancelled(position, cancelledAt, stamp) =>
    known.Some? ==> known.value.since <= cancelledAt
}

function leaseStep(known: Option<Hold>, e: LeaseEvent): Option<Hold>
  requires leaseAdmits(known, e)
{
  match e
  case Changed(change, seqNo) => Some(applyChange(known, change, seqNo))
  case Cancelled(position, cancelledAt, stamp) =>
    (match known case None => None case Some(h) => Some(cancelHold(h, position, cancelledAt, stamp)))
}

predicate leaseHistoryAdmitted(known: Option<Hold>, es: seq<LeaseEvent>)
  decreases |es|
{
  |es| == 0 || (leaseAdmits(known, es[0]) && leaseHistoryAdmitted(leaseStep(known, es[0]), es[1..]))
}

function leaseFold(known: Option<Hold>, es: seq<LeaseEvent>): Option<Hold>
  requires leaseHistoryAdmitted(known, es)
  decreases |es|
{
  if |es| == 0 then known else leaseFold(leaseStep(known, es[0]), es[1..])
}

// The lease the fold holds is well formed: an ended lease ended at or after it started.
predicate leaseWellFormed(hold: Hold) {
  hold.readThrough >= 0 && (hold.ended? ==> hold.until >= hold.since)
}

// One step keeps the start, never lowers the read position, never changes an
// ended lease, and ends a lease only at or after its start.
lemma LeaseStepKeeps(known: Hold, e: LeaseEvent)
  requires leaseWellFormed(known)
  requires leaseAdmits(Some(known), e)
  ensures leaseStep(Some(known), e).Some?
  ensures leaseWellFormed(leaseStep(Some(known), e).value)
  ensures leaseStep(Some(known), e).value.since == known.since
  ensures leaseStep(Some(known), e).value.claimedAt == known.claimedAt
  ensures leaseStep(Some(known), e).value.readThrough >= known.readThrough
  ensures known.ended? ==> leaseStep(Some(known), e).value == known
{
}

// The invariant holds across every admitted history: the start is fixed by the
// first change, the read position never moves back, and ended is final.
lemma LeaseHistoryKeeps(known: Hold, es: seq<LeaseEvent>)
  requires leaseWellFormed(known)
  requires leaseHistoryAdmitted(Some(known), es)
  decreases |es|
  ensures leaseFold(Some(known), es).Some?
  ensures leaseWellFormed(leaseFold(Some(known), es).value)
  ensures leaseFold(Some(known), es).value.since == known.since
  ensures leaseFold(Some(known), es).value.claimedAt == known.claimedAt
  ensures leaseFold(Some(known), es).value.readThrough >= known.readThrough
  ensures known.ended? ==> leaseFold(Some(known), es).value == known
{
  if |es| > 0 {
    LeaseStepKeeps(known, es[0]);
    LeaseHistoryKeeps(leaseStep(Some(known), es[0]).value, es[1..]);
  }
}

// The first change fixes the start: every later reading of the lease keeps the
// seq and the stamp of that change.
lemma FirstChangeFixesStart(change: Change, seqNo: int, es: seq<LeaseEvent>)
  requires leaseHistoryAdmitted(None, [Changed(change, seqNo)] + es)
  ensures leaseFold(None, [Changed(change, seqNo)] + es).Some?
  ensures leaseFold(None, [Changed(change, seqNo)] + es).value.since == seqNo
  ensures leaseFold(None, [Changed(change, seqNo)] + es).value.claimedAt == change.at
{
  var first := applyChange(None, change, seqNo);
  assert ([Changed(change, seqNo)] + es)[1..] == es;
  LeaseHistoryKeeps(first, es);
}

// ---- One open exchange -----------------------------------------------------

// The record's closes in the order they landed: each range is a range, and each
// starts after the one before ends.
predicate closesOrdered(closes: seq<CloseRef>) {
  (forall i :: 0 <= i < |closes| ==> 1 <= closes[i].from <= closes[i].through)
  && (forall i, j :: 0 <= i < j < |closes| ==> closes[i].through < closes[j].from)
}

function throughsOf(closes: seq<CloseRef>): seq<int> {
  seq(|closes|, i requires 0 <= i < |closes| => closes[i].through)
}

lemma ThroughsSorted(closes: seq<CloseRef>)
  requires closesOrdered(closes)
  ensures forall i, j :: 0 <= i < j < |throughsOf(closes)| ==> throughsOf(closes)[i] <= throughsOf(closes)[j]
  ensures forall i :: 0 <= i < |throughsOf(closes)| ==> throughsOf(closes)[i] >= 1
{
}

// The seq the last close reaches, as `openExchange` computes it.
function closedThrough(closes: seq<CloseRef>): int
  requires closesOrdered(closes)
{
  ThroughsSorted(closes);
  lastOf(throughsOf(closes))
}

// The open exchange is the earliest question after the last close. Every other
// question that could open one comes at or after it.
lemma OneOpenExchange(messages: seq<Message>, people: seq<string>, closedThrough: int)
  requires forall i, j :: 0 <= i < j < |messages| ==> messages[i].seq_ < messages[j].seq_
  requires openingQuestion(messages, people, closedThrough).Some?
  ensures var q := openingQuestion(messages, people, closedThrough).value;
    q.seq_ > closedThrough
    && forall k :: 0 <= k < |messages| && opensExchange(messages[k], people, closedThrough) ==> messages[k].seq_ >= q.seq_
{
  openingQuestion_ensures(messages, people, closedThrough);
  var q := openingQuestion(messages, people, closedThrough).value;
  var i :| 0 <= i < |messages| && messages[i] == q && forall j :: 0 <= j < i ==> !opensExchange(messages[j], people, closedThrough);
  forall k | 0 <= k < |messages| && opensExchange(messages[k], people, closedThrough)
    ensures messages[k].seq_ >= q.seq_
  {
    if k < i { assert !opensExchange(messages[k], people, closedThrough); }
  }
}

// A close of the open exchange starts at the open question and ends at the
// record's last seq. Both paths that write one have this shape: the close the
// room admits, and the close a cancellation carries. Such a close keeps the
// closes ordered, so no two exchanges overlap. Every question that could open
// an exchange after the last close lands inside the closed range.
lemma CloseExtendsTheRecord(messages: seq<Message>, people: seq<string>, closes: seq<CloseRef>, close: CloseRef, lastSeq: int)
  requires forall i, j :: 0 <= i < j < |messages| ==> messages[i].seq_ < messages[j].seq_
  requires forall i :: 0 <= i < |messages| ==> 1 <= messages[i].seq_ <= lastSeq
  requires closesOrdered(closes)
  requires openingQuestion(messages, people, closedThrough(closes)).Some?
  requires close.from == openingQuestion(messages, people, closedThrough(closes)).value.seq_
  requires close.through == lastSeq
  ensures closesOrdered(closes + [close])
  ensures forall k ::
    0 <= k < |messages| && opensExchange(messages[k], people, closedThrough(closes))
    ==> close.from <= messages[k].seq_ <= close.through
{
  ThroughsSorted(closes);
  var through := closedThrough(closes);
  var q := openingQuestion(messages, people, through).value;
  openingQuestion_ensures(messages, people, through);
  OneOpenExchange(messages, people, through);
  lastOf_ensures(throughsOf(closes));
  var i :| 0 <= i < |messages| && messages[i] == q;
  assert q.seq_ <= lastSeq;
  forall k | 0 <= k < |closes| ensures closes[k].through < close.from {
    assert throughsOf(closes)[k] == closes[k].through;
    assert closes[k].through <= through;
  }
}

// The close the room admits has that shape, and the exchange it closes is not
// live.
lemma AdmittedCloseExtendsTheRecord(messages: seq<Message>, people: seq<string>, closes: seq<CloseRef>, close: CloseRef, lastSeq: int, live: bool)
  requires forall i, j :: 0 <= i < j < |messages| ==> messages[i].seq_ < messages[j].seq_
  requires forall i :: 0 <= i < |messages| ==> 1 <= messages[i].seq_ <= lastSeq
  requires closesOrdered(closes)
  requires openingQuestion(messages, people, closedThrough(closes)).Some?
  requires var q := openingQuestion(messages, people, closedThrough(closes)).value;
    admitsClose(Some(OpenExchange(q.from, q.seq_)), close, lastSeq, live)
  ensures closesOrdered(closes + [close])
  ensures !live
{
  var q := openingQuestion(messages, people, closedThrough(closes)).value;
  admitsClose_ensures(Some(OpenExchange(q.from, q.seq_)), close, lastSeq, live);
  CloseExtendsTheRecord(messages, people, closes, close, lastSeq);
}
