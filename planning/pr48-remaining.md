# What is left of PR 48

PR 48 is the branch `SPLIT_PLAN.md` cut into fifteen pull requests. This
page says what each one still needs, after what landed on `main` and
what the open pull request carries. Read it with the plan on the PR 48
head, tagged `split-source` in a local clone.

## Landed

| Plan | Pull request | What it is                                                                 |
| ---- | ------------ | -------------------------------------------------------------------------- |
| 1    | #49          | The `Runtime` value, the layers, the harness                               |
| 2    | #50          | One serial commit queue, under a key                                       |
| 3    | #51          | The seat side behind three JSON calls                                      |
| 4    | #52          | The composition, the identities and every close on the log; the fold       |
| 5    | #53          | Leases on the log, `decide`, `resumeSession`, `runtime.evict`              |
| 6    | #54          | The chaos tier: a crash at every write, a kill, the walk; the doubt path   |
| 7    | #56          | Wake attempts; who heard a message, read off the log's order; the handover |
|      | #57          | The history tier and `docs/durability.md` (outside the plan)               |
|      | #59          | The run row as the fence; LemmaScript on the real rules (outside the plan) |

Two things the plan gave PR 7 landed another way. `heard` on the lease
rows is not needed: the fold reads who was at work when a message landed
from the position of the rows. `wakes` naming the seats at work is not
needed for the same reason. What PR 7 still owes is below.

## PR 7, the remainder: the live proof of a resume

**Scope.** `test/live/resume.test.ts` from the branch: a room on a real
model dies mid-activation, a second runtime resumes it, and the seat
answers again after the backoff. `test/live/loop.test.ts` from `2b0c65b`
where it differs from `main`.

**What it needs.** The two test files only. The runtime side is on
`main`. `test/live/support.ts` may need the fake clock the kill test
uses, so the wait for the expiry does not cost sixty real seconds.

**Size.** Small. One day.

## PR 8: the review fixes

**Scope.** Six faults a review of the branch found. Three are on `main`
already: the revoked draft that kept a summary owed (`STOOD_DOWN` holds
`revoked`), `joinLater` (gone), and the live-seat scan (`liveSeats` is a
set). Three remain.

**What it needs.**

- `seat/seat.ts`: `SeatActor.queued` is one string, so a second wake
  that lands while one activation releases drops the first queued one,
  and a wake that lands in the release window can start a second
  activation. The queue becomes an array, `run` resolves when it drains,
  and the race in `take` between the release and the next claim is
  closed. `test/seat.test.ts` first and third tests from `ef252c1`.
- `session.ts`: a `startSession` whose composition the record refuses
  must free the name (`free`), and `deliverFrom` must refuse a delivery
  directed at the assistant. The three session tests from `ef252c1`.
- `session.ts` `commit`: the stale check runs ahead of the queue, so a
  commit from a lease that ended is answered `stale` before `missed`.

**Docs.** `docs/agent.md` §5 abort bullet; `docs/assistant.md` §6.

**Size.** Small. `git cherry-pick -x ef252c1` and drop the hunks that are
on `main`.

## PR 9: `cut` on the wire

**Scope.** The room reaches a seat through two calls, `wake` and `cut`.
`cut` names an activation whose lease the room ended, so the seat side
stops it now, in process and over RPC. `session.ts` talks to ports only:
`cut` in `session.ts` still does `port instanceof SeatActor`, which is
the one place the room knows what a port is.

**What it needs.** `wire.ts` (`SeatPort.cut`), `seat/seat.ts` (`cut`,
`cutCurrent`, `cutOff`, `renew` returning `'stale' | 'lost' | number`,
`renewUntil` cutting on `stale` and arming a cut at the held expiry on
`lost`), `session.ts` (`cut` ending the leases, then `port.cut`),
`test/support/transport.ts` forwarding `cut`, `test/seat.test.ts` second
test. The Cloudflare seat object (PR 14) depends on this.

**Docs.** `docs/agent.md` §5 "The room reaches a seat through two".

**Size.** Small. Take the `cut` hunks from `3517d45`.

## PR 10: a deadline on every activation

**Scope.** No lease runs past `runtime.wake.deadline` from its claim,
ten minutes by default. The room caps the expiry of every claim and
renewal at the claim time plus the deadline. The seat notices a renewal
that moves the expiry nowhere and cuts the activation there.

**What it needs.** `host/runtime.ts` (`wake.deadline`), `session.ts`
(`claim` computing the capped expiry), `seat/seat.ts` (`renewUntil`
arming the cut when `renewed <= held`), `test/lease.test.ts` "expires an
activation at its deadline". A naming point: the branch folds the claim
time as `LeaseState.since`, and `main` uses `since` for the seq the first
row landed after. The claim time needs another name, `claimedAt`, folded
from the first row's `at`.

**Docs.** `docs/agent.md` §5 lease paragraph; `docs/durability.md` §4.

**Size.** Small, after PR 9. About sixty lines of source.

## PR 11: a row at the cap

**Scope.** The fold reports every pending wake and every owed draft with
its attempts, and the cap is the room's decision. `decide` returns
`abandoned`: for each wake or draft at `retry.attempts`, the attempt the
room does not make, ended `abandoned` before it starts. The row answers
the wake or the close, and the host hears an `abandoned` event. Backlog
item 29 closes.

**What it needs.** `wire.ts` (`EndReason` gains `abandoned`), `types.ts`
(the event), `room/lease.ts` (`statusOf` stops filtering at the cap;
`givesUp` in `rules.verified.ts` moves to the decision), `room/fold.ts`
(`STOOD_DOWN` gains `abandoned`; `foldOwed` stops filtering at the cap),
`room/reconcile.ts` (`abandonments`, `Decision.abandoned`, the close
withheld while an abandonment is pending), `session.ts` (`abandon`,
`WRITES_OFF`). The two cap cases in `test/reconcile.test.ts`; the chaos
cast under trouble must still end whole, and the history checker's
`drained` reads an abandoned wake as answered.

**Docs.** `docs/agent.md` §5 and the event list; `docs/assistant.md`
§16; `docs/durability.md` §4; backlog item 29.

**Size.** Medium. Take the `abandon` and `capped` hunks from `3517d45`.

## PR 12: the checkpoint

**Scope.** Every `runtime.checkpoint.rows` rows, the room writes an
`ambion/checkpoint` row: the composition and the leases a
later fold still reads, behind a floor below which every wake was
answered. The fold reads a checkpoint in place of every row before it;
the log drops those rows from memory after the replay and after each
write. Backlog item 27 closes.

**What it needs.** `wire.ts` (`CheckpointRow`), `log/log.ts` (the entry
kind, `compact`, `rowsSinceCheckpoint`), `room/fold.ts` (`sorted` reading
a checkpoint, `floor`, `checkpointOf`), `host/runtime.ts`
(`checkpoint.rows`), `session.ts` (`checkpoint()` after a pass that
writes nothing), `test/checkpoint.test.ts`, `test/restart.test.ts` with
`checkpoint: { rows: 3 }`. Two things the branch did not have: the
checkpoint must carry the fence, that is the run whose row stood when it
was written, and a checkpoint a superseded run wrote past the fence is
void like any other entry. The chaos sweep and the history tier must run
with a small checkpoint interval, so every crash point lands on both
sides of a checkpoint.

**Docs.** `docs/agent.md` §5 "A checkpoint bounds what a fold costs";
`docs/durability.md` §1; backlog item 27.

**Size.** Medium to large. The fence makes it larger than the plan said.

## PR 13: the SQLite storage in the core, and the storage contract

**Scope.** `host/sqlite.ts`: Pi's `SessionStorage` over any SQLite a
host reaches through two calls, `run` and `all`. The test support wraps
`node:sqlite`, and every scenario, the restart suite, the chaos sweep and
the history tier run on a third storage.

**What the fence adds.** This is where the remainder of backlog item 35
lands. The log's storage contract becomes Ambion's own: `appendAfter`,
an append that names the position it expects and fails when the storage
moved, and `readSince`, a read from a cursor that sees every writer. Pi's
memory and JSONL repositories implement it over their own calls, without
the conditional append; SQLite implements both in one transaction. With
the conditional append, a superseded run's write past the fence is
refused before it is acknowledged, and `split.test.ts` turns its last
allowed loss into a guarantee. The read before every write becomes a
read of the entries since the cursor, which SQLite indexes.

**What it needs.** `packages/ambion/src/host/sqlite.ts` from the branch,
the contract in `types.ts`, `log/log.ts` over the contract, `index.ts`
exports, `test/support/storage.ts` (`nodeSql`, `sqlite`, three
storages), `test/matrix.test.ts`, the widened sweep and the history tier
on SQLite, and a `split.test.ts` case on SQLite where nothing is lost.

**Docs.** `docs/toolchain.md` §8 on three storages; `docs/agent.md` §5
storage paragraph; `docs/durability.md` §1, §5 and §6; backlog item 35.

**Size.** Large. The storage contract is new design, and it is the piece
that makes the fence lossless.

## PR 14: the Cloudflare adapter

**Scope.** A room as Durable Objects: one object holds the room over the
core's SQLite storage on `ctx.storage.sql`, one object holds each seat
and runs one actor inside one alarm, RPC is the wire with `cut` over it,
and the object's alarm is the clock. Private, tested inside workerd,
deployed by nothing.

**What it needs.** `packages/cloudflare/**` from the branch, whole, on
top of PR 9 and PR 13. `knip.json`, the `CLAUDE.md` row, `docs/toolchain.md`
§1 and §8 on the workerd tier. Three things the branch did not have:
the room object resumes with the fence, so a stale stub's late write is
void; the seat object retries a claim and a release once, as the actor
on `main` does; and `planning/findings-distributed.md` names the
boundaries the objects must keep, one object per room, one per seat and
none per exchange. Items 37 to 41 in the backlog stay open after it:
tool effects, the configuration plane, the audit stream, the workspace
service and durable events are each their own work.

**Docs.** The package README; `docs/durability.md` §5 on what the
platform guarantees for the room object.

**Size.** Large. Most of the code exists on the branch.

## PR 15: the demo that crashes, and its report

**Scope.** The runnable example drops its runtime as the first answer to
Sam's question lands, resumes it in a second runtime over the same log,
and the report shows the leases the dead run held, when they expired,
the wakes sent again, and the message the exchange closed into.

**What it needs.** `examples/site/src/demo.ts`, `scripts/report.mjs`,
`demos/README.md`, and a report regenerated on the branch with a key,
because the log format changed since the branch captured it: the run
row, the `written` stamp, `abandoned`, the checkpoint.

**Size.** Small, after PR 11 and PR 12. Needs a provider key.

## The order

PR 8, then PR 9 and PR 10 together, then PR 11, PR 13, PR 12, PR 14, PR
7's remainder and PR 15. PR 13 goes before PR 12 because the checkpoint
must carry the fence and the storage contract fixes what the fence
reads. PR 7's remainder and PR 15 both need a key, and both read better
once the room abandons at the cap.
