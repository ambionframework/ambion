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
