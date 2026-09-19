// Hand-written proofs over the generated rules. `check-extra.sh` verifies this file.
include "rules.roster.verified.dfy"

// ---- The roster loop is complete -------------------------------------------

// Every seat wokenBy admits among the first r is in the answer. By induction
// over r: the generator proves soundness, and this proves completeness.
lemma WokenUpToComplete(roster: seq<Seat>, r: int, author: Option<string>, target: Option<string>, reach: int, busy: seq<string>)
  requires 0 <= reach <= 3
  requires 0 <= r <= |roster|
  decreases r
  ensures forall s :: 0 <= s < r && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists i :: 0 <= i < |wokenUpTo(roster, r, author, target, reach, busy)| && wokenUpTo(roster, r, author, target, reach, busy)[i] == roster[s].name
{
  if r > 0 {
    WokenUpToComplete(roster, r - 1, author, target, reach, busy);
    if wokenBy(roster[r - 1], author, target, reach, held(busy, roster[r - 1].name)) {
      assert wokenUpTo(roster, r, author, target, reach, busy) == wokenUpTo(roster, r - 1, author, target, reach, busy) + [roster[r - 1].name];
      forall s | 0 <= s < r && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name))
        ensures exists i :: 0 <= i < |wokenUpTo(roster, r, author, target, reach, busy)| && wokenUpTo(roster, r, author, target, reach, busy)[i] == roster[s].name
      {
        if s < r - 1 {
          var i0: int :| 0 <= i0 < |wokenUpTo(roster, r - 1, author, target, reach, busy)| && wokenUpTo(roster, r - 1, author, target, reach, busy)[i0] == roster[s].name;
          assert wokenUpTo(roster, r, author, target, reach, busy)[i0] == roster[s].name;
        } else {
          assert wokenUpTo(roster, r, author, target, reach, busy)[|wokenUpTo(roster, r - 1, author, target, reach, busy)|] == roster[r - 1].name;
        }
      }
    } else {
      assert wokenUpTo(roster, r, author, target, reach, busy) == wokenUpTo(roster, r - 1, author, target, reach, busy);
    }
  }
}

// What `woken` answers: never the author, never a seat at ordinary work, only
// roster names, for a directed say or a summary nobody but the target, and
// every seat wokenBy admits.
lemma WokenIsExact(roster: seq<Seat>, author: Option<string>, target: Option<string>, reach: int, busy: seq<string>)
  requires 0 <= reach <= 3
  ensures |woken(roster, author, target, reach, busy)| <= |roster|
  ensures forall i :: 0 <= i < |woken(roster, author, target, reach, busy)| ==> !isAuthor(author, woken(roster, author, target, reach, busy)[i])
  ensures forall i :: 0 <= i < |woken(roster, author, target, reach, busy)| ==> !held(busy, woken(roster, author, target, reach, busy)[i])
  ensures forall i :: 0 <= i < |woken(roster, author, target, reach, busy)| ==> onRoster(roster, woken(roster, author, target, reach, busy)[i])
  ensures reach == 1 ==> forall i :: 0 <= i < |woken(roster, author, target, reach, busy)| ==> isNamed(target, woken(roster, author, target, reach, busy)[i])
  ensures reach == 0 ==> forall i :: 0 <= i < |woken(roster, author, target, reach, busy)| ==> isNamed(target, woken(roster, author, target, reach, busy)[i])
  ensures forall s :: 0 <= s < |roster| && wokenBy(roster[s], author, target, reach, held(busy, roster[s].name)) ==> exists i :: 0 <= i < |woken(roster, author, target, reach, busy)| && woken(roster, author, target, reach, busy)[i] == roster[s].name
{
  wokenUpTo_ensures(roster, |roster|, author, target, reach, busy);
  WokenUpToComplete(roster, |roster|, author, target, reach, busy);
}

// ---- What the scale promises -----------------------------------------------

// The scale is monotone: a wider seat hears everything a narrower one hears,
// except a message that names the narrower seat (`named` is false on both sides).
lemma HearsWider(narrow: Attention, wide: Attention, reach: int)
  requires 0 <= reach <= 3
  requires width(narrow) <= width(wide)
  ensures wakes(narrow, false, reach) ==> wakes(wide, false, reach)
{
}

// A summary wakes nobody: it names no seat and reaches no seat.
lemma SummaryWakesNobody(roster: seq<Seat>, author: Option<string>, to: Option<string>, subject: Option<string>, directed: bool, busy: seq<string>)
  ensures |woken(roster, author, targetOf(MessageKind.summary, to, subject), reachOf(MessageKind.summary, directed), busy)| == 0
{
  var target := targetOf(MessageKind.summary, to, subject);
  var reach := reachOf(MessageKind.summary, directed);
  targetOf_ensures(MessageKind.summary, to, subject);
  reachOf_ensures(MessageKind.summary, directed);
  WokenIsExact(roster, author, target, reach, busy);
  var w := woken(roster, author, target, reach, busy);
  if |w| > 0 {
    isNamed_ensures(target, w[0]);
    assert false;
  }
}

// A directed say wakes at most the seat it addresses.
lemma DirectedSayWakesOnlyTarget(roster: seq<Seat>, author: Option<string>, to: string, subject: Option<string>, busy: seq<string>)
  ensures forall i :: 0 <= i < |woken(roster, author, targetOf(MessageKind.said, Some(to), subject), reachOf(MessageKind.said, true), busy)| ==> woken(roster, author, targetOf(MessageKind.said, Some(to), subject), reachOf(MessageKind.said, true), busy)[i] == to
{
  var target := targetOf(MessageKind.said, Some(to), subject);
  var reach := reachOf(MessageKind.said, true);
  targetOf_ensures(MessageKind.said, Some(to), subject);
  reachOf_ensures(MessageKind.said, true);
  WokenIsExact(roster, author, target, reach, busy);
  var w := woken(roster, author, target, reach, busy);
  forall i | 0 <= i < |w| ensures w[i] == to {
    isNamed_ensures(target, w[i]);
  }
}

// A seating wakes the seat it seats: the newcomer is on the roster the routing
// reads, the seating names it, and an idle non-author target is always woken.
lemma SeatingWakesNewcomer(roster: seq<Seat>, author: Option<string>, subject: string, attention: Option<Attention>, busy: seq<string>)
  requires !isAuthor(author, subject)
  requires !held(busy, subject)
  ensures exists i :: 0 <= i < |woken(rosterFor(roster, true, subject, attention), author, targetOf(MessageKind.seated, None, Some(subject)), reachOf(MessageKind.seated, false), busy)| && woken(rosterFor(roster, true, subject, attention), author, targetOf(MessageKind.seated, None, Some(subject)), reachOf(MessageKind.seated, false), busy)[i] == subject
{
  var r := rosterFor(roster, true, subject, attention);
  var target := targetOf(MessageKind.seated, None, Some(subject));
  var reach := reachOf(MessageKind.seated, false);
  rosterFor_ensures(roster, true, subject, attention);
  targetOf_ensures(MessageKind.seated, None, Some(subject));
  reachOf_ensures(MessageKind.seated, false);
  var s := |roster|;
  assert r[s].name == subject;
  isNamed_ensures(target, subject);
  wokenBy_ensures(r[s], author, target, reach, held(busy, subject));
  WokenIsExact(r, author, target, reach, busy);
}
