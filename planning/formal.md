# Formal: verified rules for the journal and the room

This file is the record of the review that made the journal in
`packages/journal` and the room in `packages/ambion/src/room` decide by
verified rules, and the list of what is still open. It names each gap,
the rule that closes it, the contract the rule carries, and the call site
that runs the rule's body. [`docs/formal.md`](../docs/formal.md) states
the mechanism a contributor uses. [next.md](next.md) owns the 0.1.0
scope; this file feeds its phase 8 evidence line.

The review behind this file ran on 2026-09-19 against main `914951c`. It
read both packages, the design contracts, and the LemmaScript 0.6.1
toolchain. Nine readers proposed 92 candidate gaps, and a critic nine
more. A verifier and a refuter judged each one against the code with
running probes and differential fuzzing. Of the 101 candidates, 79
survived both, 11 were refuted or restated, 8 were already carried, and
1 was outside the envelope. Every rule this file keeps survived, and
the three core state machines decide by verified rules: the journal's
fence, the activation lifecycle, and the exchange lifecycle. The two
rules files and two proofs files carry 161 obligations. The other groups
were landed, proven, and then returned to ordinary TypeScript by
decision, because a proof pays for itself only on a machine whose
failure loses or duplicates work.

**A rule is verified when the runtime runs its body.** LemmaScript turns
a `//@ requires` and `//@ ensures` contract on a pure TypeScript function
into a Dafny obligation. The proof is about that function. The proof
reaches the system only when the journal or the room imports the function
and runs it on the path the contract describes.

## What existed at the start of the review

**Two files carried ten rules and thirteen obligations.** Every rule was
a boolean or an integer helper over scalars. `lsc check --backend=dafny`
regenerates each `.dfy.gen`, and Dafny proves the lemma beside each
function.

| File                                         | Rule                 | Caller                         | What the contract says                          |
| -------------------------------------------- | -------------------- | ------------------------------ | ----------------------------------------------- |
| `packages/journal/src/rules.verified.ts`     | `nextSeq`            | `journal.ts` `land`            | The next seq is the last one plus one           |
|                                              | `voided`             | `journal.ts` `voided`          | Void needs a fence, a writer, and another run   |
|                                              | `supersedes`         | `journal.ts` `pass`            | Own entry landed and another run's followed     |
|                                              | `keyConflict`        | `journal.ts` `land`            | Another kind, or a fence key of another run     |
| `packages/ambion/src/room/rules.verified.ts` | `expired`            | `lease.ts` `isExpired`         | Now reached the expiry                          |
|                                              | `atWork`             | `delivery.ts` `atWork`         | A change before the message, an end after it    |
|                                              | `coversAttempt`      | `lease.ts` `coversAttempt`     | Running, or the message is at or before the end |
|                                              | `givesUp`            | `reconcile.ts` `capped`        | The attempts reached the cap                    |
|                                              | `nextAttempt`        | `lease.ts` `pendingActivation` | The failed attempts plus one                    |
|                                              | `beforeCancellation` | `fold.ts`, `activation.ts`     | The position is before the marker               |

**The contracts restate the bodies.** Each `ensures` names the same
expression the body returns, so the proof establishes that the body has
that shape. The meaning of each boolean input is computed by the caller,
and no contract reaches it. `voided` is proven for three booleans; the
fence position, the writer, and the run that produce those booleans in
`journal.ts` are on no obligation. `atWork` is proven for four integers.
That `since` is the seq of the first lease change, and `until` the seq of
the end, is a fact of `applyLease`, and no contract states it.

**CI verifies the list in `LemmaScript-files.txt`.** The `lemmascript`
job in `.github/workflows/ci.yml` calls the LemmaScript reusable workflow
at a pinned commit with `typecheck: false`. `pnpm check` does not run
`check:lemmascript`. The `.dfy` and `.dfy.gen` pairs are identical, so
no hand-written proof exists yet. `docs/durability.md` §7 cites the room
file and omits the journal file.

## What LemmaScript 0.6.1 can express here

**The envelope is in [`docs/formal.md`](../docs/formal.md) §6.** The
probes on this branch fixed it, and every rule below stays inside it. Two
rows came out of the landing itself: two records with the same fields are
two Dafny datatypes, so a shared predicate is written per record; and a
quantifier with no function call inside it has no trigger, so a
per-position lemma over a range is stated on the range's bounds.

## A. The journal

**The fence is one verified state machine, and this branch runs it.** The
journal folds every stored entry through `fenceStep` in
[`rules.verified.ts`](../packages/journal/src/rules.verified.ts), which
takes the fence as the last read left it, the entry's kind and writer, and
this run's name, and answers the fence after the entry, whether the journal
keeps the entry, and whether the caller hears `lost`. `journal.ts` runs it
in `take`, where three fields and three methods stood. The `.dfy` carries
the lemmas the generator cannot write, by induction over a read:

| Lemma                            | What it says                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `SupersededIsAbsorbing`          | A superseded journal stays superseded through any read                           |
| `FencedIsAbsorbing`              | A fenced journal stays fenced                                                    |
| `NoRunEntryKeepsFence`           | A read that passes no run entry leaves the fence where it stood                  |
| `BeforeFirstFenceEverythingKept` | Every entry before the first run entry is kept                                   |
| `NeverFencedNeverSuperseded`     | A run that never meets its own entry is never superseded                         |
| `LostAtMostOnce`                 | The caller hears `lost` at most once, and never once superseded                  |
| `KeptAfterFenceIsTheFencesRun`   | After the fence of run r, a kept stamped entry is r's                            |
| `OwnThenOtherSupersedes`         | Own fence, then another run's: superseded, and `lost` at that step               |
| `CounterCoversCache`             | The counter is at least every cached seq, so the next seq is unused              |
| `CursorNeverMovesBack`           | The cursor after a read is at least where it stood and every position it scanned |

**Four more rules carry the key, the counter, the cursor, and the storage.**
`keyed` decides a key in one rule: fresh, replay, or conflict, with the
same-run test inside the rule. `advanceSeq` and `scanned` replace two
`Math.max` calls whose meaning no contract reached. `admit`,
`nextPosition`, and `readPosition` carry the storage contract into
`memory.ts` and `sqlite.ts`. Dafny proves 41 obligations in three seconds.

**Three edge behaviors came out of the proofs, and each is now a rule.**
A refuter built each one as a running probe against the code.

1. **A stamped write before the run's own fence.** A run whose entry is
   not on the journal, while another run's fence stands, could append an
   entry, receive its seq, and have every reader void it; its own fence
   then took the same seq. `writable` refuses the write with "this run
   must land its run entry first". The room writes `run` first on start
   and on resume, so nothing in the room changes.
2. **A seq at the safe-integer boundary.** A stored seq of 2^53 passed
   `positionOf`, and three appends then took one seq, because `2^53 + 1`
   is `2^53` in a double. The proof over integers could not see it. The
   contracts of `nextSeq` and `advanceSeq` now carry the bound, `positionOf`
   takes no seq at or past it, and `land` refuses a write at the last
   place.
3. **A read past the head.** After positions 1 and 2, `read(5)` reported
   position 2 on the memory adapter and 5 on SQLite. `readPosition` gives
   both adapters one answer: never before the position read after.

**Left for the plan.** Each item names the file it changes.

- **A1. The visible-entries filter as a loop rule.** Landed on this
  branch. `read` filtered the storage's answer inline.
  `visibleEntries(entries, after)` with an index loop proves soundness
  (every result is past `after`), completeness (every stored entry past
  `after` is in the result), and membership. The `filter` form proves
  soundness only, because Dafny's `Seq.Filter` does not unfold.
  `journal.ts` `read` and `memory.ts` `read` run it.
- **A2. The cursor rule in every consumer.** Landed on this branch.
  `packages/cloudflare/src/storage.ts` `refresh` and
  `packages/pi-journal/src/index.ts` `refresh` each kept a cursor by
  hand: the Cloudflare one assigned each entry's position and took a max
  only at the end, and the Pi one took no max. Both run `scanned` per
  entry, and the journal package exports it from `index.ts` for that.
- **A3. A journal with no run.** Decided and landed on this branch.
  `sameWriter(undefined, undefined)` was true, so a journal that writes
  for no run treated an unstamped run entry as its own fence, and a
  stamped run entry after it superseded the reader. `journal.ts` says
  such a journal reads the fence like any other reader. `sameWriter` now
  needs both names, the lemma `NoRunReadsLikeAnyReader` proves a
  writerless journal is never fenced, never superseded, and never hears
  `lost`, and a test holds it. Three more lemmas prove that which entries
  a step keeps never depends on who reads, so an entry `writable` admits
  is one every reader at the same fence keeps.
- **A4. A malformed seq.** `positionOf` skips a stored entry whose seq is
  not a place, as it skips a foreign kind. A known kind with a bad seq is
  corruption, and a skip hides it. `envelope` throws for it, as it throws
  for a known kind with a bad body, once D3's golden journals can show
  the change is safe.
- **A5. The storage conformance suite runs the rules.** D6 publishes a
  storage conformance suite. Its cases for the compare-and-append and the
  read past the head assert the three storage rules by name, so a
  Postgres adapter proves the same contract.

## B. The lease fold

**Landed on this branch.** Every rule below is in the room's rules file
with its proof. `lease.ts` and `fold.ts` run them, and the binding test
names them. The `AttemptIdsAreFresh` lemma is the first hand-written
addition in the room's `.dfy`. Dafny proves the room file's 56
obligations in seven seconds.

**One step rule replaces `applyLease`.** `applyChange(known, change, seq)`
takes the lease the fold holds for an id, one lease entry, and the entry's
seq, and answers the lease after it. Its contract is the lease's life:

- An ended lease is final: `known.phase == 'ended' ==> \result == known`.
- `since` and `claimedAt` are set by the first change and never move.
- `readThrough` never decreases, and takes the change's value on a running
  lease.
- An ending change sets `until == seq` and the change's reason, so
  `since <= until` and the interval `atWork` and `coversAttempt` read is
  the interval the journal recorded.

`lease.ts` `applyLease` becomes one line:
`leases.set(change.id, applyChange(leases.get(change.id), change, seq))`.
The rules file redeclares `Hold`, `Change`, and `Reason` beside the rule,
because LemmaScript lowers only the types in its own file and Biome's layer
rule points `lease.ts` at the rules and never back. `LeaseHold` in
`lease.ts` is the rule's `Hold`; the cancellation rule writes the
`cancelled` marker itself.

**A cancellation is a second step rule.** `cancelHold(hold, position,
cancelledAt, at)` ends a running lease whose cause is before the marker.
The lease ends as `revoked` with `until == cancelledAt`, and keeps `id`,
`since`, `claimedAt`, and `readThrough`. Every other lease stays as it
was. `fold.ts` `cancelLeases` runs it per lease. `docs/durability.md` "Cancellation"
promises this boundary; today two comparisons in `fold.ts` and one in
`exchange.ts` restate `beforeCancellation` by hand without calling it.

**Which lease answers which message is one rule.** `answers(taken, seq)`
reads a `Taken` record: the phase, the reason, `readThrough`, and the
position the id names. It states what `docs/durability.md` §4 promises
and `lease.ts` `answered` computed by hand. A running lease answers every
message it covers. A failed or expired lease answers nothing. A released
lease answers only positions at or below its acknowledged `readThrough`.
An abandoned or revoked lease answers the position its id names, or one
it acknowledged. Two rules read it:

- `wakeAnswered(taken, seq)` is the `some` over the covering leases;
  `statusOf` returns no wake exactly when it holds, so a pending wake never
  runs beside a live activation for the same message.
- `countsAgainst(lease, seq)` says which covering lease is an
  unsuccessful attempt: one that came to nothing, or one that ended for
  any reason and names the message. `failed.length` feeds `nextAttempt`
  and, through `unsuccessfulAttempts`, `givesUp`.

`lease.ts` maps a `LeaseHold` to a `Taken` with `decodeActivationId`, which
stays outside the envelope, and runs the three rules in `statusOf`.

**The schedule after failed attempts is a rule.** `schedule(unsuccessful,
last, backoff)` answers the next attempt number and `notBefore`: nothing
after no failures, and `last + backoff` after some. `latest(times, floor)`
is the `Math.max(0, ...)` with a contract. `pendingActivation` runs both;
`Date.parse` on the lease's `at` stays at the call site.

**Two scalar rules gain the clauses that relate them.** `atWork` gains
`\result ==> coversAttempt(ended, until, seq)`. Every message a lease was
steered with is one the lease covers, so an unanswered steer to a lease
that came to nothing is pending again for that seat. `coversAttempt`
gains downward closure in seq. No call site changes.

**`isLive` and `isExpired` become rules over the phase.** Today both are
arrow functions in `lease.ts` around the verified `expired`. As rules over
`Phase`, the contract states the dichotomy: a running lease is live or
expired and never both, and an ended lease is neither. `transition.ts`,
`reconcile.ts`, and `routing.ts` read them through `lease.ts` unchanged.

**`removedAfter` is a rule over the removal positions.** `lease.ts`,
`reconcile.ts`, `exchange.ts`, and `activation.ts` each wrote
`unseated && subject === seat && seq > position` by hand. One rule over
the seqs of the seat's removals replaced four copies, and `removalsOf` in
`lease.ts` is the one projection they share.

## C. The reconciliation

**Landed on this branch.** Every rule below is in the room's rules file
with its proof, `reconcile.ts`, `summary.ts`, and `room-host.ts` run
them, and the binding test names them.

**The header of `reconcile.ts` overclaims, and a trace refutes it.** The
file promises that "a second decision over the result writes nothing". A
refuter traced the fold at a fixed clock. A pass expires a lease. The
next pass finds the retry the fold now owes and writes it off at the cap.
The next closes the exchange, and the next owes a summary draft. The
room converges, and each pass writes something new. The header now states
what the code does: each pass writes what the fold owes after the last, and the
loop stops at the pass that writes nothing. A proof of convergence needs
a measure over the fold and waits for tranche 3.

**Six pure decisions in the pass become rules.** Each one is arithmetic or
a case split today, with no contract, and each carries a promise of
`docs/durability.md` §4.

- **C1. `endingOf(running, stale, pastExpiry)`** answers `'revoked'`,
  `'expired'`, or `'stays'`. A running lease with a stale seat is revoked;
  one past its expiry and not stale is expired; a lease is never both, a
  revocation wins, and an ended lease is never ended again. `revocations`
  and `expiries` fold into one `endings` loop that runs it, with
  `staleLease(derived, seated, removedAfterCause)` as the stale test.
- **C2. `mayClose(stopped, endings, exchangeOpen, exchangeLive)`** is the
  gate before a close: not stopped, no lease ended this pass, an exchange
  open, and nothing of its work live. `planReconciliation` runs it where
  the `settled` conjunction stands. `docs/durability.md` §6 promises that
  a stopped room closes nothing and wakes nobody; the sends, the
  abandonments, and the alarm each gate on `stopped` by hand, and the
  same rule gates all four.
- **C3. `waitsUntil(now, backedOff, notBefore, wasSent, sentAt, resend)`**
  is the moment an owed activation waits for: the backoff when it is
  ahead, else the end of the resend window, else now. `readyToSend` is
  `waitsUntil <= now`, and the contract states that equivalence. `dueAt`
  and `dueWakes` run them.
- **C4. `earliestAfter(now, times)`** is the alarm: strictly after now, no
  later than any future time in the list, one of them, and absent exactly
  when none is after now. `nextAlarm` runs it over the live expiries and
  the retry times; `looksAgainAt` gives each owed activation its retry
  time, one resend window after a send this pass.
- **C5. `forgets(sentIds, dueIds)`** is the sent set minus the due set:
  every forgotten id was sent and is not due, and an id still due is never
  forgotten, so no activation is resent before its window. `forgotten`
  runs it.
- **C6. `answers(running, reason, atCause, readThrough, seq)`** is the same
  rule as B's `answers`, in the scalar form `lease.ts` `answered` runs
  today. B and C name one rule; B's `Taken` record is the shape the room
  keeps.

- **C7. `exchangeLive(leases, owed, now)`** is the question `liveWork`
  answers over projected `LiveLease` and `OwedActivation` records: the
  exchange's own work is live exactly when a running, unexpired lease a
  message caused exists or an activation a message caused is owed; a
  close-caused activation holds no exchange open. `mayClose`,
  `admitsClose`, and `closeMoved` take it. The seats live now stay a
  projection in `liveSeats`; a `seatLive` rule is open work.

**Two lemmas relate the rules across files.** `endingStands` says that a
lease the pass ends as expired or revoked is one `mayEnd` in
`transition.ts` accepts at any later clock reading, because `expired` is
monotone in `now`. Without it the decision and the write are two rules
with no proof that the second admits the first. `stillExpired` is the
monotonicity on its own. Neither has a runtime caller; both are rules in
the file, and `rules.test.ts` imports them so that Knip keeps them.

**`mayEnd` moves from `transition.ts` into the rules.** Its four lines are
the reason gate: an unknown lease ends only as revoked or abandoned; an
ended lease never changes; a running lease is revoked at will, ends as
expired only past its expiry, and as released or failed only before it.
The probe file in this branch proved the contract over named string
unions. `end` in `transition.ts` runs it with `isExpired` as the input.

## D. The transitions

**Landed on this branch.** Every rule below is in the room's rules file
with its proof; `transition.ts`, `exchange.ts`, `lease.ts`, `answers.ts`,
and `room-host.ts` run them, and the binding test names them.

**`decide` was a set of case splits with no contract.** Each helper in
`transition.ts` is a table over a few booleans, and each table is a
promise of `docs/agent.md`: the say lock, the lease deadline, one lease
per seat, the reason gate, the purpose grant, the close admission, and the
one-summary rule. A rule per table moves the table into the rules file and
leaves the helper as the adapter that reads the state.

- **D1. The say lock.** `speechFreshness(readThrough, lastSeq)` answers
  `'invalid'`, `'missed'`, or `'fresh'`: a position off the record is
  invalid, one short of `lastSeq` is missed and the refusal carries the
  messages after it, and `lastSeq` itself is fresh. `onRecord(position,
lastSeq)` is the bound, and `progressValid` is the same bound for a
  renewal or a release. The `typeof` and `Number.isSafeInteger` guards
  stay at the call site, outside the envelope. A closing commit skips
  freshness by design, and the rule's scope says so.
- **D2. The lease deadline.** `leaseExpiry(now, claimedAt, expiry,
deadline)` is `min(now + expiry, claimedAt + deadline)`, with the
  contract that matters: a fresh claim expires after now, and a renewal
  expires after now exactly when the deadline has not passed, so a live
  lease renewed under the same deadline stays live. `runningLease` runs
  it; `Date.parse` on `claimedAt` stays at the caller.
- **D3. One lease per seat.** `admitsLease(kind, known, live, owed,
seatHeld)` answers `'granted'`, `'ended'`, or `'held'`: a claim runs only
  for an activation the fold owes whose seat holds no other live lease; a
  renewal runs only while its own lease is live; an ended lease never
  runs again. The refuter found the finder's first draft granted a renewal
  with no known lease; the rule now refuses it, as `renew` does through
  its `leases.has` check.
- **D4. The reason gate.** `mayEnd` moves into the rules file (C).
- **D5. The purpose grant.** `permits(purpose, intent)` is the two-by-three
  table: both purposes permit speech, only a response permits a seating or
  an unseating, and a closing activation can do nothing but speak. The
  probe file in this branch proved it over named unions.
- **D6. The close admission.** `admitsClose(open, close, lastSeq,
exchangeLive)` admits a close only for the open exchange's owner and
  `from`, at `through == lastSeq`, with nothing of the exchange's work
  live. Once written, no question after `through` exists, so the same
  close is refused a second time. `closeBoundary(open, lastSeq)` builds
  the close both `reconcile.ts` `closing` and the cancel body build by
  hand today.
- **D7. One summary per exchange.** `coversExchange(summaryTo, summary,
owner, from, through)` is the coverage predicate `transition.ts`
  `isCoveringSummary` and `exchange.ts` `summaryCompletion` each write by
  hand; `stampedSummary` builds the summary a closing commit stamps and
  proves it covers its own purpose, so a second closing commit is refused;
  `addressesOwner` refuses any other recipient.
- **D8. Presence and membership outcomes.** `presenceOutcome(kind,
agentName, present, sameIdentity)` and `membershipOutcome(kind,
onRoster, inReserve)` each answer `'refused'`, `'unchanged'`, or
  `'written'`. `hostMembership` beside it states the documented difference
  between the agent path, which answers `unchanged`, and the host path,
  which refuses a satisfied request. `addressOutcome(directed, known,
self, attention)` is the four-way refusal of a directed message.
- **D9. The acknowledgment merge.** `acknowledged(prior, incoming)` is the
  `Math.max` that `runningLease`, `end`, and `applyLease` each write; one
  rule, three callers.
- **D10. A person's delivery.** `deliver` runs `present` on the author
  and `addressOutcome` on the recipient, the same two rules the commit
  path runs, so a person's delivery and an agent's say are refused by one
  table. The empty-text refusal stays in `message`, after both gates, as
  the refuter found it. `docs/presence.md` §4 promises the presence check
  at the commit boundary.
- **D11. A key answers only the same operation.** `deliveryMatches` and
  `contributionMatches` in `room-host.ts` decide whether the entry a
  repeated key returns is the retried delivery or commit: the same
  person, recipient, and text, or the same activation, seat, and intent.
  `docs/durability.md` §2 promises that a key reused for another author,
  recipient, text, or operation rejects. The journal's `keyed` proves the
  replay; these two rules prove the match, and `room-host.ts` imports
  them from the room's rules file, which is below it.

**One refutation changed a rule.** The finder claimed that a commit reads
as stale when its lease is dead, refused when it has no grant, and stale
when its seat left the roster, in that order. A refuter traced a lease that
is live while its seat was unseated after the cause: `activationSpec`
refuses the grant first, so the commit reads as refused, and the roster
branch in `liveSpec` is dead code. `commitAuthority(known, pastExpiry,
granted)` states the two outcomes the code has, and `liveSpec` dropped
the third.

## E. Routing, delivery, and presence

**Proven once, then returned to ordinary TypeScript by decision.** Every
rule below was landed with its proof, and `routing.ts`, `delivery.ts`,
and `presence.ts` ran it. The routing scale, the presence fold, and the
four roster lemmas are outside the line `docs/formal.md` draws: a defect
in them wakes the wrong seat and corrupts no record, so they decide as
plain code under the scripted suites. The steer (E6) stays verified,
because it decides which activation a message reaches. The proven text
is in this branch's history for the day the line moves.

**Before the review no routing rule was verified, and `docs/durability.md`
§7 said one was.** The attention scale, the reach of a message, and who
wakes were three tables; each is a rule, and one lemma states the
monotonicity the roster doc promises.

- **E1. `width(attention)`** is the scale: none 0, named 1, broadcast 2,
  presence 3. The `WIDTH` record goes. The rules file redeclares
  `Attention`, and a rule never returns the literal `'none'` as a value,
  because LemmaScript lowers that literal to `Option.None` when a value is
  expected; the scale returns numbers.
- **E2. `reachOf(kind, directed)`** is the reach: a summary reaches 0, a
  directed say 1, an undirected say 2, and every presence change 3. The
  contract enumerates the table the docs state row by row.
- **E3. `wakes(attention, named, reach)`** is the one comparison: a named
  seat wakes however narrowly it is seated; another seat wakes exactly
  when its width reaches the message's reach, and a directed say or a
  summary wakes no seat it does not name. `hearsWider(narrow, wide,
reach)` is the lemma: a wider seat hears everything a narrower seat
  hears, the named target aside. It is the `HearsWider` lemma in the
  `.dfy`.
- **E4. `wokenBy(seat, author, target, reach, busy)`** is the per-seat
  decision `routes` makes with two filter callbacks today: never the
  author, never a seat at ordinary work, always the named seat, and
  otherwise `wakes`. **`woken(roster, author, target, reach, busy)`** is the
  loop over the roster with soundness and completeness: every name it
  answers is on the roster, is not the author, is not busy, and `wokenBy`
  admits it; every seat `wokenBy` admits is in the answer. `routes` runs
  it. **`rosterFor`** appends a seating's newcomer. Which seats are busy
  stays a projection in `routing.ts`: a closing activation holds no seat.
- **E5. `targetOf(kind, to, subject)`**: a directed say names who it
  addresses, a seating names who it seats, and no other message names a
  seat.
- **E6. `steers(source, seat, author, woken, hold, seq)`** is the
  delivery rule: a message steers a message-caused lease that was at work
  when it landed, never the author's seat, never a seat the message wakes,
  and never a closing lease, so a seat is never both woken and steered by
  one message. **`atWorkHold(hold, seq)`** takes the lease record itself,
  and its ended case is an equivalence; the four-scalar `atWork` is the
  internal rule it unfolds to, and the adapter in `delivery.ts` went.
- **E7. `stepPerson(known, entry)`** is one presence entry applied to one
  person: an arrival makes the person present and keeps the last-departure
  cursor; a departure makes a known person absent and sets the cursor to
  its seq; a departure of an unknown name and every other kind change
  nothing. **`foldPresence(entries)`** is the fold, with the contract
  `docs/presence.md` states: a name is known once it arrived, and a known
  name is present exactly when its last presence entry is an arrival.
  `foldPeople` becomes the projection from messages to entries plus the
  verified fold.

**The rules file carries its own copies of the types.** `Attention`,
`MessageKind`, `Seat`, `Seating`, `Hold`, and `Person` are declared again
beside the rules, because the generator reads one file and the layer rule
keeps the rules below `lease.ts` and `types.ts`. A type test in
`rules.test.ts` asserts each copy is assignable both ways from the public
type, so the two cannot drift without a compile error. `Seat` and
`Seating` are both kept: Dafny has no structural subtyping, so the routing
rules over a name and an attention and the roster rules over a full
seating each read their own record.

## F. Activation identity and authority

**Landed on this branch.** F1, F2, F4, F5, and F6 are in the rules files
with their proofs, and `activation.ts`, `lease.ts`, `activation-id.ts`,
and five seating checks run them. F3 kept the rule B landed. F7 and F8
are open.

**The id's grammar stays in TypeScript; the authority it grants becomes a
rule.** `decodeActivationId` is a regular expression, outside the envelope.
Everything after the decode is pure logic over four fields, a roster, the
unseatings, and the closes, and today it is spread over `activation.ts`,
`lease.ts`, `exchange.ts`, `reconcile.ts`, and `fold.ts` as hand-written
comparisons.

- **F1. `activationGrant(id, cancelledAt, roster, removed, recorded,
close)`** answers the grant `activationSpec` computes: nothing for a
  position before the cancellation marker, nothing for a seat off the
  roster or removed after the cause, a `respond` purpose only for a
  recorded message position, a `summarize` purpose only for a close that
  names the seat as writer; the grant's seat and attempt are the id's own,
  and the purpose kind is fixed by the id's source. `docs/agent.md`
  "Activation and context" promises every clause. `activationSpec` is the
  adapter: decode, guard `wellFormed`, project the removal with
  `removedAfter`, find the close with `closeFor`, and run the rule.
- **F2. `closeFor(closes, through, writer)`** is the first close whose
  `through` matches and whose `summary` names the writer, with the
  contract that no earlier close matches. A cancel close carries no
  summary, and `names` refuses it.
- **F3. `removedAfter(removals, seq)`** is B's rule, and `removalsOf` in
  `lease.ts` is the one projection of a seat's removals. The four copies
  of the predicate went. An unseating at the cause position itself does
  not make the cause stale, and the contract says so.
- **F4. `nextActivationId(source, position, seat, unsuccessfulAttempts)`**
  builds the record the encoder takes: the cause's own fields, and the
  attempt one past the failed ones. `docs/durability.md` §4 promises that
  nothing mints an id; this is the one site that builds one.
- **F5. `wellFormed(id)` and `positiveBounded(value)`** state the domain
  the codec accepts: position and attempt between one and the largest safe
  integer, a non-empty seat. `safePositiveInteger` runs `positiveBounded`;
  integrality stays in TypeScript.
- **F6. `onRoster(roster, name)`** replaced five one-line scans, and is
  the vocabulary the grant's contract names.

**One refutation found a latent disagreement.** `fold.ts` `draftedOver`
counts a closed-source lease at a close's `through` as a draft of that
close for any seat; `exchange.ts` `summaryDraftOutcome` counts only the
named writer's. A journal the room writes never shows the difference,
because the room derives every closed-source id from the close's own
writer. A journal from another writer, or a summary writer changed by a
later composition, would fold two answers. **F7.** `draftsClose(id,
through, writer)` as one rule for both sites is open; `withAttempts`
already holds the writer to pass, and `draftsOf` in `exchange.ts` is the
writer-bound side today.

**One refutation corrected a claim about validation.** `validate.ts`
checks an activation id on a lease's `id` and on a message's
`activationId`, and reads no other kind. A close or a run with an
`activationId` field passes. **F8.** `storedIdAccepted(kind, present,
wellFormed)` would state what the validator does. A refusal of the field
on other kinds is a schema change that D3 in `next.md` takes.

## G. The exchange, the summary, and the roster

**Landed in part.** G1, G2, G3, and G5 are in the room's rules file with
their proofs, and `exchange.ts`, `fold.ts`, and the transition run them.
G4, G6, G7, and G8 were proven once and returned to ordinary TypeScript
by decision: the discussion range, the roster fold, the exchange a
delivery belongs to, and the cursor read are reads and folds a defect in
which corrupts no record.

**Before the review the exchange fold was not verified.** `exchange.ts`
and `fold.ts` held the rules `docs/exchange.md` §3 and §5,
`docs/summary.md`, and `docs/roster.md` state, each as a filter chain or
a case split.

- **G1. `openingQuestion(messages, people, closedThrough)`** is the open
  exchange: the first spoken message from a person after the last close's
  `through`, with soundness and completeness over the message list.
  `opensExchange` is the per-message test. `openExchange` runs it with
  the people map's keys. `lastOf(seqs)` is the last close's `through` and
  the record's `lastSeq`, as one rule.
- **G2. `summaryVerdict(covered, writerNamed, removedAfterClose, drafts,
cancelledAfterClose)`** is the outcome lattice: a covering summary from the named
  writer is published whatever the leases say; no named writer means
  silent; a writer unseated after the close means failed; a cancellation
  after the close fails a draft still owed and changes nothing published
  or stood down; a released draft settles silent, a revoked or abandoned
  one failed; and the room owes a draft exactly when the outcome is
  pending with a writer. `summaryCompletion` keeps the journal-facing
  selection and hands the rule five values. The refuter found the last
  line of `summaryDraftOutcome` unreachable, and the rule drops it.
- **G3. `coversClose(summaryFrom, summaryThrough, closeFrom,
closeThrough)`** is the containment `coversExchange` unfolds to, and
  `coversSeq` in the vocabulary's rules file is the per-position test the
  view and the renderer run. The per-position lemma over the range did
  not survive: a quantifier with no function inside it has no trigger,
  and Dafny refuses it. The containment is stated on the bounds.
- **G4. `discussion(messages, from, through)`** is the human-facing
  range: every non-summary message inside the inclusive range, in record
  order, and nothing else. `docs/exchange.md` §6 cites it for
  `waitForClose`.
- **G5. `cancelHold(hold, position, cancelledAt, at)`** writes the
  `cancelled` marker inside the rule, and `markedCancelled` reads it, so
  the `LeaseHold` type is the rules file's `Hold` whole. **`survivesCancellation(
position, cancelledAt)`** is the boundary test `fold.ts` `project` and
  `exchange.ts` write inline without calling `beforeCancellation`; both
  run it, so the one verified boundary rule has a caller on the path that
  drops pending retries.
- **G6. `reserveOf(catalog, roster)`** is the reserve: every catalog seat
  whose name is not on the roster, at broadcast attention, and nothing
  else. The catalog it takes is deduplicated by name at the call site,
  and `distinct` (D8) is its precondition. **`reseated(roster, membership)`** applies one seating or
  unseating and keeps one seat per name. **`foldRoster(agents, changes,
compositionSeq)`** applies every membership change after the
  composition's position and none at or before it, which is the restart
  promise of `docs/roster.md`.

- **G7. `exchangeContaining(closes, open, seq)`** is the exchange a
  committed question belongs to: the first close whose range holds it,
  else the open exchange when the question is at or after its opening,
  else none. `handleForMessage` in `room-host.ts` decides it with two
  `find` calls today. `docs/exchange.md` §6 promises the handle.
- **G8. `messagesSince(messages, since)`** is the exclusive cursor read:
  exactly the messages past the cursor, in record order. `read.ts`
  `selectMessages` and the unseen count in `answers.ts` run it.

**Two facts stay outside the rules and the plan states them.** The record
is ordered by seq, which the journal package proves, so `lastOf` reads
the last element as the maximum under a precondition nothing checks at
runtime. The roster is unique by construction, because `compose` runs
`distinct` on the catalog; the contracts of `reseated` and `foldRoster`
state that they keep one seat per name.

## H. The vocabulary's own rules

**Proven once, then returned to ordinary TypeScript by decision.** The
range check stays in `validate.ts` and the codec's bound in
`activation-id.ts` as plain code. Both are shape checks on the wire, and
the line `docs/formal.md` draws keeps the rules files to the three core
state machines.

- **H1. `rangeWellFormed(from, through)`.** The validator accepts a close
  with `through` before `from`, a cancel close with the same, and a
  summary whose `covers` is inverted; a refuter ran each through
  `validateRoomBody` and got `true`. Every range the room writes satisfies
  `1 <= from <= through`, and a foreign record that does not makes
  `discussion` return nothing and `openExchange` skip. The rule refuses
  the range before replay, as a malformed known body.
- **H2. `positiveBounded(value)`.** The codec's domain (F5), beside it.

**Seven changes made the proofs part of the gate.** Each one was checked
on this branch against LemmaScript 0.6.1 and the pinned CI workflow, and
[`docs/formal.md`](../docs/formal.md) states the result. Items 1, 4, 6,
and 7 are done; 2 and 3 are documented; 5 waits for a proof that outgrows
the additions block.

1. **`pnpm check` regenerates the Dafny.** `lsc gen-check --backend=dafny`
   regenerates every `.dfy.gen` in the list and fails when a committed
   generated file differs. It needs no Dafny. Add it to `check` so a
   contract edit that forgets the regeneration fails at the desk, where CI
   fails it today. `check:lemmascript` keeps the proof and needs Dafny.
2. **A timeout column above 60 stops the proof.** In batch mode `lsc check`
   runs a file whose second column is above 60 as a generation check only,
   and CI calls the batch with `backend: dafny`, which passes no `--slow`.
   Keep every timeout at 60 or below, or move CI to `dafny-slow` on the
   day a proof needs longer.
3. **A flag column carries `--standard-libraries`.** A rule that calls
   `filter` lowers to `Std.Collections.Seq.Filter`, which Dafny resolves
   only with that flag. The list accepts flags after the timeout column,
   so the line reads `path 60 --standard-libraries`.
4. **`lsc regen` after a contract edit, once a `.dfy` carries a proof.**
   `lsc gen` writes the `.dfy.gen` and leaves an existing `.dfy` alone, so
   the two drift and `lsc check` fails with "not additions-only". `lsc
regen` merges the new generation into the `.dfy` three ways and keeps
   the hand-written lemmas; it uses the previous `.dfy.gen` as the merge
   anchor, so it must run before any `lsc gen`. Today both `.dfy` files
   equal their `.dfy.gen`, so the drift cannot happen yet. The first hand
   proof changes the command in `CLAUDE.md` and `docs/toolchain.md` §6.
5. **Proofs with induction go beside the rules.** A fold lemma over a
   sequence needs an inductive proof that the generator cannot write. The
   `.dfy` takes it as an addition. A proof that grows past a screen moves
   to a `rules.proofs.dfy` beside it, and a root `check-extra.sh` verifies
   it; the pinned CI workflow runs that script when it exists and diffs
   every `.dfy` and `.dfy.gen` against the checkout.
6. **A binding test per rule file.** Nothing today checks that the runtime
   runs a rule on the path its contract describes. `pass` in `journal.ts`
   calls `supersedes(this.fenced, false)` with a literal second argument,
   so the lemma's `sameRun` clause never applies. A `rules.binding.test.ts`
   in each package mocks the rule module with a sentinel and asserts that
   the caller's decision follows the sentinel, one case per rule and call
   site. Knip already fails a rule no source file imports.
7. **The evidence table names both files.** `docs/durability.md` §7 cites
   the room file for "sequencing, routing, lease, and retry rules". No
   routing rule is verified, and the journal file is not cited. Each row
   of the table below names the rule that carries the claim, and §7 links
   the rows.

**The envelope is in `docs/formal.md` §6.** A contributor who writes a
rule outside it loses a draft to a Dafny error that names a generated
identifier. The page states the rows, the commands, and the workflow.

## The order of work

**One tranche for the journal, six slices for the room, then the fold
lemmas.** A slice lands when every rule in it has a caller, its `.dfy`
verifies, `pnpm check` passes, and the rows in `docs/durability.md` §7
name it. Each slice is one pull request with its `.dfy` regenerated by
`lsc regen`, its binding test, the type test for every redeclared union,
and its evidence rows.

| Slice | Files                                      | Rules                                                                                                                                                                                                                                                                                         | State                        |
| ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1     | `journal.ts`, `memory.ts`, `sqlite.ts`     | `fenceStep`, `keyed`, `writable`, `advanceSeq`, `scanned`, `admit`, `nextPosition`, `readPosition`, `visibleEntries`, the fold lemmas                                                                                                                                                         | Landed                       |
| 1     | the two cursor consumers                   | `scanned` at the Cloudflare and Pi cursors (A2)                                                                                                                                                                                                                                               | Landed                       |
| 2a    | `transition.ts`, `answers.ts`              | `mayEnd`, `permits`, `leaseExpiry`, `acknowledged`, `onRecord`, `speechFreshness`, `admitsClose`, `coversExchange`, `admitsLease`, `commitAuthority`, `stampedSummary`, `addressesOwner`; the presence, membership, address, `distinct`, and retry-match rules were proven once and withdrawn | Landed                       |
| 2b    | `lease.ts`, `fold.ts`                      | `applyChange`, `cancelHold`, `answers`, `wakeAnswered`, `countsAgainst`, `schedule`, `latest`, `removedAfter`, `nextActivationId`, `survivesCancellation`                                                                                                                                     | Landed                       |
| 2c    | `reconcile.ts`                             | `endingOf`, `staleLease`, `mayClose`, `waitsUntil`, `readyToSend`, `looksAgainAt`, `earliestAfter`, `forgets`, `exchangeLive`, `closeMoved`; `namesWriter` was proven once and withdrawn                                                                                                      | Landed                       |
| 2d    | `routing.ts`, `delivery.ts`, `presence.ts` | `steers` stays; the scale, `woken`, `rosterFor`, `stepPerson`, `foldPresence`, `present`, and the `HearsWider` lemma were proven once and withdrawn                                                                                                                                           | Steer landed, rest withdrawn |
| 2e    | `activation.ts`                            | `activationGrant`, `closeFor`, `names`, `wellFormed`; `onRoster` and `positiveBounded` were proven once and withdrawn                                                                                                                                                                         | Landed                       |
| 2f    | `exchange.ts`, `fold.ts`                   | `openingQuestion`, `summaryVerdict`, `lastOf`; `discussion`, `coversSeq`, `reserveOf`, `reseated`, `foldRoster`, `exchangeContaining`, and `messagesSince` were proven once and withdrawn                                                                                                     | Landed                       |
| H     | `validate.ts`, `activation-id.ts`          | `rangeWellFormed` and `positiveBounded` were proven once and withdrawn; the checks stay as plain code                                                                                                                                                                                         | Withdrawn                    |
| 3     | the two `.dfy` files                       | the lease fold over one id, one open exchange, unique roster names, the stop-loop and the pass measures; `seatLive` (C7), `draftsClose` (F7), `storedIdAccepted` (F8)                                                                                                                         | Open                         |

**The slices landed in the order 2a, 2b, 2c, 2d, 2e, 2f, then the rest
of 2a and H.** The lease step first, because `atWork` and
`coversAttempt` read the interval it pins; the pass next, because
`mayClose` and `admitsClose` take `exchangeLive` from it; then the
routing, the identity, and the exchange, each of which reshaped one file
around its rules.

**Names and types were settled once.** The accepted set named
`removedAfter` three ways, `answers` two ways, and `Seat` and `Hold`
three ways each. The room's rules file keeps one `removedAfter` over the
seqs of a seat's removals (B), one `answers` over a `Taken` record (B),
one `Seat` for the routing and one `Seating` for the roster (E), and one
`Hold` with the `cancelled` marker (G5). `rules.test.ts` asserts each
against `types.ts`.

**A lemma with no caller lives in the proofs file.** `AttemptIdsAreFresh`,
`StillExpired`, and `EndingStands` state relations between rules and have
no runtime call site, so they are written in Dafny in the `.proofs.dfy`
beside the rules, and `check-extra.sh` verifies them. The `.dfy` equals
its generation, so a regeneration never merges.

**The room's rules are one file.** `rules.verified.ts` holds the lease,
the admissions, the grant, the steer, the exchange, the verdict, the
pass, and the close, and proves in about fifteen seconds. The routing,
roster, and record rules were split into two more files for a time; the
scope decision removed them.

**Tranche 3 waits for the addressed projection.** A lemma over the fold is
a lemma over that shape, so the lease fold, the exchange fold, and the
roster fold lemmas land with B1 in `next.md`. Two liveness facts belong
here: a measure the stop loop decreases, and a measure each
reconciliation pass decreases, so the `PASSES` bound is a proof. Today
only the chaos drain and the walk's `drained` check witness them.
`AttemptIdsAreFresh` is small enough to land with 2b.

**What no tranche proves.** The regular expression that decodes an id,
`Date.parse` on a stamp, `typeof` and `Number.isSafeInteger` on the wire,
and the storage's compare-and-append in SQL stay outside the envelope;
each is one line at a call site, and the binding test covers it. The
clock never runs backwards, and the record is ordered by seq; the first
is a host promise and the second the journal's proof.

## Evidence

**This branch proved what it proposed, and the runtime runs it.** Every
rule in this file is in a runtime rules file with its proof and its
callers, or is named as open work above. The evidence of each slice is
the rules file, the binding test that names the rule, and the type test
that pins its copies.

| Group                                               | File                                         | Obligations        | Status                                            |
| --------------------------------------------------- | -------------------------------------------- | ------------------ | ------------------------------------------------- |
| A. Journal                                          | `packages/journal/src/rules.verified.ts`     | 18, and 23 proofs  | Landed                                            |
| B, C, D1 to D7, D9, F, G1 to G3, G5, the steer (E6) | `packages/ambion/src/room/rules.verified.ts` | 106, and 14 proofs | Landed                                            |
| E1 to E5, E7, G4, G6 to G8, D8, D10, D11, H         | their concern files                          | none               | Proven once, then ordinary TypeScript by decision |
