# Simplification

Ten changes that remove concepts from the core. Every item names what it
is, why it costs, where it lives, and the change that removes it. The
items sit in order of how many concepts they remove.
[`backlog.md`](backlog.md) holds the debt and the deferred design work.
[`next.md`](next.md) holds five of these ten, and this file supersedes its
order.

Nothing here removes a capability. Five items are new. Four sharpen an
item `next.md` already holds, and the text says which. One promotes a
note `next.md` left in the margin.

## The finding

**The core holds one idea, and it is written three times.** The idea is
work owed, derived from a journal. A message that woke a seat is one kind of
owed work. A close that owes a summary is a second kind. A wake this run
has sent is a third. Each kind has its own vocabulary, its own identifier
format, and its own count of attempts.

**Most of the concept count follows from that.** The core exports 108
names for five primitives. `SessionImpl` holds 58 methods and 24 fields.
The assistant appears in 14 of the 24 source files. Each number has a
different local cause, and the three causes share one root.

## 1. One owed activation, in place of a wake and a draft — the fold landed

`next.md` §3 holds this as a note. The fold and the vocabulary landed. One
piece waits on a decision, and the text names it.

**What.** `room/lease.ts` folds the wakes a message owes.
`room/fold.ts` folds the summaries a close owes. Both produce `Due`.
`statusOf` and `withAttempts` run the same four steps: count the leases
that came to nothing, read the latest of their times, derive the next
identifier, and add the backoff.

**Why.** The two copies have moved apart. `lease.ts` counts `failed` and
`expired` as an attempt. `fold.ts` counts `failed`, `expired` and
`refused`. Two functions carry the name `cameToNothing`, with two
signatures and two sets of reasons. The divergence costs nothing today,
because only a draft ends `refused`. Nothing holds the two sets together,
so the next reason to arrive lands in one copy.

The two kinds then reach every module that reads them. `parseId` returns
two kinds. `seatOf` needs the assistant's name to resolve a draft.
`handOf` branches on the kind. `working` tests the kind of every
identifier a seat holds. `liveSeats` reads two lists.

**Where.** `packages/ambion/src/room/lease.ts`, `pendingWakes`,
`statusOf`, `cameToNothing`, `activationId`, `parseId`;
`packages/ambion/src/room/fold.ts`, `foldOwed`, `withAttempts`,
`cameToNothing`, `draftId`; `packages/ambion/src/room/reconcile.ts`,
`liveSeats`, `working`.

**Fix.** One concept: an activation the room owes, caused by a position
on the journal. A message causes one. A close causes one. The cause is a
position either way. One identifier format, one fold over the attempts,
one backoff, one set of reasons.

**What landed.** `dueFrom` folds the attempts once, for both causes, and
derives the id of every activation the room owes. `Cause` is `message` or
`close`, `ParsedId` is one shape with a `cause` and a `position`, and the
five readers that branched on `seq` against `through` read `position`.
`WakeOptions` is `DueOptions`.

The two reason sets are one where they agree, and the review found they
disagree for a reason neither copy stated. `lease.ts` asked one set two
questions: _did the attempt come to nothing_, and _did the lease answer
what it heard_. `fold.ts` asked the first alone, and counted `refused`
for it. The sets are named for their questions now, and `CAME_TO_NOTHING`
derives from `ANSWERS_NOTHING`, so the part they share cannot drift:

```text
ANSWERS_NOTHING  = { failed, expired }
CAME_TO_NOTHING  = ANSWERS_NOTHING + { refused }
```

`rules.test.ts` pins the difference with the one case that shows it: a
message that landed between a lease's last renewal and its end.

**What waits, and why.** One identifier format. A message-caused id is
`<seq>:<seat>` and a close-caused id is `close:<through>:<attempt>`, so a
close names no seat and `seatOf` still takes the assistant's name to
resolve one. One spelling would end that. It also rewrites 139 ids the
tests hold and every lease id on a journal already written, so a room
resumed over one would not parse its own. Decide it with a storage
format change, not on its own.

**What it unblocks.** Items 2 and 3 both carry the two kinds through
today. This item makes each of them a smaller change.

## 2. The assistant as data

New.

**What.** `docs/assistant.md` says the assistant is a seat, and that two
things make it one, and that both are data. The code holds the
assistant's name as a parameter through `fold.ts`, `lease.ts`,
`reconcile.ts`, `view.ts` and `seat.ts`. Fourteen of the 24 source files
name it.

**Why.** `Attention` ranks messages on one widening scale: `none`,
`named`, `broadcast`, `presence`. The assistant wakes for two things that
are not messages. An opened exchange wakes it, and a closed exchange
wakes it. Neither sits on the scale, so the room writes the assistant's
name into `wakes` at two points in the code.

Every other special case follows. `seatOf` falls back to the assistant
for a draft. `working` asks whether a live identifier belongs to the
assistant. `wakes` takes a `fromAssistant` flag. `handOf` compares the
seat to the assistant. `foldOwed` filters the closes by the assistant's
name.

**Where.** `packages/ambion/src/session.ts`, `routing`, `steer`,
`assistant`; `packages/ambion/src/room/reconcile.ts`, `closing`,
`working`, `liveSeats`; `packages/ambion/src/room/lease.ts`, `seatOf`,
`reached`; `packages/ambion/src/room/fold.ts`, `foldOwed`;
`packages/ambion/src/room/view.ts`, `handOf`;
`packages/ambion/src/seat/seat.ts`, `wakes`.

**Fix.** A seating names what wakes it, and the two room events are
two of the names. The scale keeps its job for the reach of a message.
Then `assertAssistant`, the fallback in `seatOf`, the assistant clause in
`working`, the `fromAssistant` flag, the comparison in `handOf` and both
written-in names all go. `RoomFacts.assistant` and `OwedContext.assistant`
go with them.

**What it buys.** The runtime stops holding a privileged seat. A host
writes one assistant as configuration, and the README's claim about
agents as the unit of ownership holds in the code.

## 3. Split `session.ts` by phase

`next.md` §4 asks for this split, and names three faces. This item names
a different line to cut along.

**What.** `SessionImpl` is 1439 lines, 58 methods and 24 fields. It holds
the room's lifecycle, the host's API, the seat's three calls, the write
path, the reaction to every journal entry, the reconcile loop and the
waiters.

**Why.** Eight of the 24 fields hold state the room cannot derive: the
journal, the definitions, the visits, the ports, the listeners, the run
identifier, the transport and the runtime. The rest are a cache
(`fold`, `sentAt`), a lifecycle (`replayed`, `stopped`, `evicted`), an
event guard (`idleReported`), or a handle on something in flight
(`reconciling`, `cancelAlarm`, and the two arrays of waiters).

`decide` in `reconcile.ts` is already pure. It reads the folded state
and the clock, and returns the entries to write and the wakes to send. That
shape is correct, and today it covers one part of one pass.

**Where.** `packages/ambion/src/session.ts`, `SessionImpl`;
`packages/ambion/src/room/reconcile.ts`, `decide`.

**Fix.** Fold the journal, compute a `Decision`, apply it. Widen `decide` to
cover the whole step. A `Room` value holds the journal, the clock and the
runtime. The three calls a seat makes become functions over that value.
`next.md` §1 names the lifecycle field this needs, and it stays the first
part of this item.

## 4. One order for the messages and the entries — done

New. It carried a trade-off, and the text names what it cost.

**What.** One journal carries three positions. A message takes a `seq`. Every
other entry takes an `after`, the last seq when it landed. A read
holds Pi's own entry seq as a cursor.

**Why.** `LeaseHold` needs eight fields. Five of them are positions or
times that rebuild one fact: when the activation existed, and what it
read. Two verified rules answer that question, and one of them takes six
parameters:

```text
heard(liveOrFailed, since, ended, until, heardThrough, seq)
```

Six parameters and four `ensures` clauses decide whether an interval
holds a point. `checkpointOf` carries the same cost in `floorOf`,
`reads` and `named`.

**Where.** `packages/ambion/src/wire.ts`, `LeaseHold`, every entry body;
`packages/ambion/src/room/lease.ts`, `foldLeases`, `atWork`, `heard`;
`packages/ambion/src/room/rules.verified.ts`, `atWork`, `heard`;
`packages/ambion/src/room/fold.ts`, `checkpointOf`.

**Fix.** Every entry takes a position from the counter the messages take
theirs from. Then `after` goes. A lease's `since` and `until` become the
positions of its own first and last entries. `atWork` and `heard` become one
check that an interval holds a point.

**What landed.** `heard` reads the end alone. `foldLeases` holds every
lease to `until >= since`, so `since` decides nothing the end does not
already decide, and the rule drops a parameter:

```text
heard(liveOrFailed, ended, until, heardThrough, seq)
```

`packages/ambion/test/rules.test.ts` pins the new rule against the old
formula for every lease the fold can build.

**What the counter cost.** One counter gives out every place, and `after`
is gone from every body. The journal's envelope holds one required `seq`
in place of `seq?` and `after?` with a rule about which, and
`Vocabulary.positioned` is `Vocabulary.record`: the kind that makes up the
record a reader reads, which is no longer a statement about position.

The counter needed the second one this text predicted. `lastSeq` is the
place the last entry took; `lastCommitted` is the place the last record
entry took. Three places read the wrong one at first, and the seat's
renewal loop was the one that showed it: `ViewResponse.lastSeq` and
`LeaseResponse.lastSeq` name a place on the record, and feeding them the
journal's counter made every renewal report its own landing as movement.
The activation read again, renewed again, and the room wrote leases until
it ran out of memory. The wire says what `lastSeq` means now.

**What it ended.** The messages were contiguous from 1, and they are not
any more: the fence and the composition take the first two places, and a
lease change sits between two messages. Three test invariants stated the
contiguity and now state what is true — every place is its own and in
order, and a summary stands through the last message before it, leaving no
message between. A reader's numbering is a rendering job, and `render.ts`
holds it: `numbered` counts the messages up to a place, so a participant
reads the message's place on the record and never the journal's.
`backlog.md` item 48 records it.

**The trade-off.** Today a `seq` is a position on the record a person
reads, and the messages are contiguous. One shared counter ends the
contiguity. Nothing in the code needs it: `covers` is a range, `since` is
a filter, and `renderRecord` walks the list. A reader's numbering is a
rendering job, and `render.ts` can hold it. Do this item with item 5,
while the storage format is open.

## 5. `@ambionframework/journal` — done

`next.md` §3 asked for this. It landed second.

**What.** `src/journal/` and `src/host/sqlite.ts` are 791 lines: an
append-only record over pluggable storage, fenced by run, checkpointed,
and honest about a write it is in doubt about.

**Why.** The record is the part of this project with the strongest
claims and the least to do with agents. It has its own contract in
[`../docs/durability.md`](../docs/durability.md), its own proofs in
`journal/rules.verified.ts`, and its own test tiers.

**Where.** `packages/ambion/src/journal/journal.ts`;
`packages/ambion/src/journal/rules.verified.ts`;
`packages/ambion/src/host/sqlite.ts`.

**Fix first.** `RoomLog` holds a `leased` set and passes a `first` flag
to `hear`. Both exist so the room emits `activation_start` once per
activation. That is lease vocabulary inside the journal, and it is the journal's
one mention of a seat. The room derives `first` from the fold, and the
set and the flag go.

**Then.** `@ambionframework/journal` holds the journal, the fence, the
checkpoint and the storages. The room depends on it the way it depends on
Pi: for one concern, through one interface.

**The envelope landed after it.** The package came out with the envelope
and the body saying the same things twice: every body carried its own
`seq`, a message carried its own `key`, and the run stamp had a third
name, `written`. The journal reached into a body to read a place, and a
caller that wrote a place had to agree with the journal about it. Now the
storage holds three fields beside every body — `seq`, `key` and `run` —
and the journal reads those three and never a body. `Drafts` is gone with
them: a draft is a body, and `Omit<T, 'seq'>` said nothing a caller
needed to say. `record`, `since` and `commit` speak in entries, and the
room joins the envelope to the body in one place,
`packages/ambion/src/journal/journal.ts`. `Fence` says only when a run
took the name, and `Checkpoint`, `Close` and `LeaseChange` name no place
at all.

## 6. `@ambionframework/workspace` — done

`next.md` §2 asked for this. It landed first.

**What.** `src/tools/` is 704 lines: a virtual filesystem, a shell, and
the four hands an agent holds over them.

**Why.** `bash-env.ts` and `just-bash.ts` hold no reference to a message,
a seq, a room or a seat. `workspace.ts` holds two. The directory is the
largest part of the core that a reader skips to understand a room. It
carries most of what stops the package bundling for a runtime with no
disk ([`backlog.md`](backlog.md) §44).

**Where it went.** `bash-env.ts` and `just-bash.ts` moved to
`packages/workspace/src/`. `packages/ambion/src/tools/workspace.ts` stayed.

**What landed.** `@ambionframework/workspace` holds the two backends and
the just-bash adapter, 509 lines. The core keeps `defineWorkspace`,
`destroyWorkspace`, the handle, the resolver and the four hands, and it
drops `just-bash` from its dependencies. The main entry imports no
`node:fs`.

**One decision the plan did not name.** The four built-in hands stayed in
the core, against `next.md` §2, which asked for them to move. They are
Pi's own tools over an `ExecutionEnv`, so they need no filesystem, and the
core already commits to them: `BUILTIN_TOOL_NAMES` refuses a custom tool
under one of the four names, and `render.ts` states their reach to a
connected agent. The idea of a workspace is the core's, and the filesystem
behind it is not.

**The API changed.** `defineWorkspace`'s `backend` field is required. It
defaulted to an in-memory just-bash filesystem, and the core holds no
filesystem to default to. A host names `memoryBackend()` where it named
nothing.

## 7. One author on every message

New.

**What.** A message has six kinds and three interfaces. Three guards
sort them, and `isPresence` reads as a negative: a message is a presence
message when it is neither spoken nor a summary.

**Why.** `types.ts` records its own exception. A seating names its
subject in `from` and its author in `by`. It is the one message whose
author and its subject differ. `authorOf` exists for that one case, and
`routing`, `steer` and `commit` each call it.

**Where.** `packages/ambion/src/types.ts`, `PresenceMessage.by`,
`authorOf`, `isPresence`; `packages/ambion/src/session.ts`, `routing`,
`steer`, `commit`.

**Fix.** `from` names the author of every message. A seating names its
subject in its own field. Then `authorOf` goes, `isPresence` reads as a
positive test, and rule 7 in [`../docs/agent.md`](../docs/agent.md) holds
for every kind.

## 8. One question about what is live

New. [`backlog.md`](backlog.md) §43 records one fault this causes.

**What.** Six functions answer one question: `settled`, `quiet`, `idle`,
`working`, `liveSeats` and `stilled`. `RoomLog.settled` answers a
seventh. `idleReported` guards the `quiet` event, and two arrays hold the
callers that wait.

**Why.** [`backlog.md`](backlog.md) §43 records that a draft inside its
backoff lets the room report quiet. One fact with six spellings admits
faults of that kind.

**Where.** `packages/ambion/src/session.ts`, `settled`, `quiet`, `idle`,
`live`, `stilled`, `settle`, `idleReported`;
`packages/ambion/src/room/reconcile.ts`, `liveSeats`, `working`.

**Fix.** One function reports the live work over the folded state and the
clock. `settled` and `quiet` read it as two tests. `idleReported` becomes
an edge over one value. Item 1 makes this smaller, because the two lists
`liveSeats` reads become one.

## 9. One retry policy

New.

**What.** Five mechanisms retry, in five shapes.

| Where          | Mechanism                                  |
| -------------- | ------------------------------------------ |
| `journal.ts`   | `byKey`, an idempotency key per commit     |
| `session.ts`   | `sentAt` and the resend window             |
| `lease.ts`     | attempts, backoff and cap, off the journal |
| `seat/seat.ts` | `for (attempt < 2)`, written twice         |
| `seat/seat.ts` | `queued.includes`, a dedupe on the wakes   |

**Why.** The policy off the journal survives a crash, because a fold rebuilds
it. The two counted loops in `SeatActor` hold their count in memory, and
a restart loses it.

**Where.** `packages/ambion/src/seat/seat.ts`, `claim`, `release`,
`enqueue`; `packages/ambion/src/session.ts`, `sentAt`, `forget`;
`packages/ambion/src/journal/journal.ts`, `byKey`.

**Fix.** `Runtime` names one policy, and every caller reads it.

## 10. Collapse the exported names

`next.md` §5 asks for this, and it stays last.

**What.** The package exports 108 names for five primitives.

**Why.** Items 1, 2, 5 and 6 take about 40 of those names out with their
modules. A pass before them moves names that are about to leave.

**Where.** `packages/ambion/src/index.ts`.

**Fix.** The main entry exports what a host needs to build a room. Every
other shape reaches a reader through a named subpath. `Session`,
`SessionView`, `RunningRoom` and `SeatRoom` are one room from four sides.

**What landed with item 5.** A naming pass took out the duplicates the
journal split exposed: `LeaseState`, an alias of `LeaseHold` with no
difference; the core's `Committed`, a second shape under the journal's
name; and `Positioned`, which nothing read. The journal package stopped
exporting seven helpers that only it calls. `Row` is gone as a word: an
entry on the journal is an `Entry`, a lease writes a `LeaseChange`, and
`Fence` names what a run writes first. `runtime.checkpoint.rows` is
`runtime.checkpoint.entries`.

## The order

The order to do them differs from the order of their value:

**6, 5 with 4, 1, 2, 3, 8, 9, 7, 10.**

**The workspace goes first.** It is the lowest risk, and it proves the
extraction pattern.

**The record follows, and it carries item 4.** The storage format is open
while the package moves, so the positions change once.

**Item 1 comes third.** One owed activation is what makes item 2
tractable, and item 2 is what makes item 3 a split.

**Items 7, 8 and 9 are cheap after 1, 2 and 3 land.** Each removes a
vocabulary that the earlier items have already thinned.

**Item 10 reads the result.** The count of exported names measures the
other nine.

## What comes out

**Two packages, and each is stronger on its own.**
`@ambionframework/journal` is an append-only journal, fenced by run and
checkpointed, that holds no reference to an agent.
`@ambionframework/workspace` is a filesystem, a shell and four tools.

**One package waits.** The durable scheduler in item 1 has the shape of a
library, and the shape is not settled. Keep it in the core until item 2
has taken the assistant out of it. `next.md` §3 gives the reason: two
subjects that share a shape hide whether the shape is right.

**The measure.** The core loses about 1500 lines and four vocabularies:
the wake and the draft, the author and the subject, six tests for what is
live, and five retry policies. One privileged seat becomes configuration.
