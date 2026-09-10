# Split plan: PR 48 as a stack of small PRs

This file is an input for cutting
[PR 48](https://github.com/ambionframework/ambion/pull/48), head `9782eb6`,
into a sequence of PRs that each leave `main` green and reach the same
final tree. Delete this file with the last PR of the stack.

## How to read this plan

**The final tree is the source.** Every PR below takes files from the
final tree, `9782eb6`, and trims what a later PR adds. That is easier than
teasing the branch's commits apart, because the branch's third commit
(`dece292`) did five things at once. Where a branch commit is clean, the
plan says so and a cherry-pick works.

```sh
git fetch origin claude/implement-attached-plan-mse2st
git tag split-source 9782eb6
# take a file as it ends up, then trim it
git checkout split-source -- packages/ambion/src/log/log.ts
# see the whole delta for one path
git diff main..split-source -- packages/ambion/src/log/log.ts
# take a branch commit whole
git cherry-pick -x <sha>
```

**The layout lands first.** PR 1 creates the layers and the Biome rules
that hold them, so every later PR puts a file in its final place once.
The branch did this last (`8f0c1bc`); the stack does not need a rename PR.

**Every PR meets the same bar.** `pnpm format && pnpm check` green;
docs describe what the PR built and nothing it did not; the backlog item
a PR closes is closed in that PR; the commit message says what changed
in Simplified Technical English; no log format compatibility is owed,
because no log exists outside the tests, and a PR that changes the
entries says "logs written before this PR do not resume".

**Stack the branches.** Each PR branches from the one before it. Merge in
order. A change requested on PR n is made on PR n and rebased forward.

## The stack

| PR  | Name                                                       | From the branch                            | Size              | Needs |
| --- | ---------------------------------------------------------- | ------------------------------------------ | ----------------- | ----- |
| 1   | The runtime value, the layers, and the harness             | `90d5871`, the layout of `8f0c1bc`         | ~1.4k             | main  |
| 2   | The serial commit queue                                    | `0f44d6c`                                  | ~0.6k             | 1     |
| 3   | The wire and the seat actor, leases in memory              | derived                                    | ~1.2k             | 2     |
| 4   | The room's shape on the log: composition, closes, the fold | part of `dece292`                          | ~0.8k             | 2     |
| 5   | Leases on the log, `decide`, and `resumeSession`           | rest of `dece292`, `174aca5`               | ~2.0k             | 3, 4  |
| 6   | The chaos tier, the doubt path, and the three faults       | `8bd7a08`, `ed04f13`, `3fb7efd`, `9782eb6` | ~1.2k             | 5     |
| 7   | Wakes name every seat, leases carry `heard`, retries       | `20dfe55`, `2b0c65b`, resume test          | ~0.9k             | 6     |
| 8   | The review fixes                                           | `ef252c1`                                  | ~0.4k             | 7     |
| 9   | `cut` on the wire                                          | part of `3517d45`                          | ~0.2k             | 8     |
| 10  | A deadline on every activation                             | part of `3517d45`                          | ~0.2k             | 9     |
| 11  | A row at the cap                                           | part of `3517d45`                          | ~0.3k             | 10    |
| 12  | The checkpoint                                             | part of `3517d45`                          | ~0.4k             | 11    |
| 13  | The SQLite storage in the core                             | part of `3517d45`                          | ~0.4k             | 6     |
| 14  | The Cloudflare adapter                                     | `3defaf3`, `a20ba46`, later deltas         | ~0.9k             | 9, 13 |
| 15  | The demo that crashes, and its report                      | `4474de1`, `346cf31`                       | ~0.2k + generated | 12    |

PRs 1 to 7 landed on main as #49, #50, #51, #52, #53, #54 and #56. PRs 4
and 5 landed with decisions the branch had not made; the note under PR 5
says what they are, and the branch holds them now. PR 6 landed as the
branch has it, with its doubt tests in `test/doubt.test.ts`. PR 7 landed
with a different mechanism for the same outcomes; the note under PR 7
says what the branch adopted and what it kept. #55 rewrote the README
files and added `docs/assets/ambion-exchange.svg`; the branch took them
as they are. #57, outside the plan, added `docs/durability.md`, the
history checker (`test/consistency.test.ts`, `test/support/history.ts`)
and the split tests (`test/split.test.ts`), and made the seat ask a lost
claim or release again once. The branch took them as they are, with
`heard` on the release the branch's rows carry.

Sizes are lines of diff without the lockfile and the generated report.
PRs 9 to 12 are independent of each other and could land in any order;
the order above keeps each rebase small. PR 13 only needs the doubt path
and could go right after PR 6.

---

## PR 1: The runtime value, the layers, and the harness

**Scope.** No behaviour change. A `Runtime` value replaces the module
level globals: the clock, the session opener, the model call, the catalog
and the register of running rooms. The core's layers exist, with the
Biome rules that hold them. The test harness that every later PR runs on:
the fake clock, the storage matrix, the invariants, the scenarios.

**Files to take from the final tree.**

- `packages/ambion/src/host/runtime.ts`. Trim: `Transport`,
  `RunningRoom` and the `transport` option (PR 3); `wake.deadline` (PR 10);
  `checkpoint` (PR 12); `retry` (PR 5). Keep `Clock`, `SessionOpener`,
  `ModelResolver` in `types.ts`, where the final tree has them.
- `packages/ambion/src/types.ts`: the host contracts and
  `BUILTIN_TOOL_NAMES` (backlog item 5 closes here). Trim the event and
  message fields later PRs add: `wakes`, `activationId`, the `abandoned`
  event, the `Exchange` shapes stay where main has them until PR 4.
- `packages/ambion/src/tools/{workspace,just-bash,bash-env}.ts`: a move of
  main's three files, with `defineWorkspace` taking a `Runtime`.
- `biome.jsonc`: the layer overrides and the two cross-package rules, as
  they are in the final tree. A rule for a directory that does not exist
  yet is harmless.
- `docs/toolchain.md` §1 "The core's layers" and the `CLAUDE.md` row and
  code rule.
- Tests: `test/support/{clock,storage,invariants,scenarios}.ts`,
  `test/matrix.test.ts`, `test/runtime.test.ts`. Trim `storage.ts` to
  `memory` and `jsonl` (SQLite is PR 13) and drop the `tappedOpener` and
  `faultyOpener` helpers (PR 6). Trim `invariants.ts` of `inherited` and
  `inheritedExchange` (PR 5) and of the lease check (PR 5).

**Extract.** `git cherry-pick -x 90d5871` is close: it puts `runtime.ts`
at the root with the contracts inside it. After the pick, move the file
to `host/`, move the contracts to `types.ts`, move the tools, and add the
Biome overrides. `docs/agent.md` §5 "A host owns a `Runtime`" comes with
the pick.

**Watch for.** `session.ts` on main keeps its shape; only its globals move
into the runtime it is handed. Do not start the refactor of `session.ts`
here.

---

## PR 2: The serial commit queue

**Scope.** `log/log.ts` replaces `record.ts`. One commit at a time on a
serial queue; a repeated key lands once; a commit with `readThrough` below
the last seq is refused inside the queue link with what it missed; nothing
observes a message before its write is confirmed. The entries on the
storage do not change: messages only. Rule 5 is enforced where the write
happens.

**Files.** `packages/ambion/src/log/log.ts` from the final tree, trimmed
of: the `lease`, `close`, `composition` and `checkpoint` entry kinds and
`write()` (PR 4, PR 5, PR 12); the doubt path, `cursor`, `known`, `found`
and `compact` (PR 6, PR 12). What is left is `RoomLog` with `commit`,
`land`, `since`, `settled` and the replay of messages. `test/log.test.ts`:
the first four tests. `docs/agent.md` rule 5 paragraph on the queue.

**Extract.** `git cherry-pick -x 0f44d6c` applies cleanly on PR 1 after
the path change to `log/log.ts`. It is the branch's own step and needs no
trimming.

---

## PR 3: The wire and the seat actor, leases in memory

**Scope.** The seat side becomes a client of three JSON calls. `wire.ts`
names what crosses: the seat calls `view`, `commit` and `lease`; the room
calls `wake`. `seat/activation.ts` is one activation over a view;
`seat/hands.ts` holds `say`, `summarise` and `seat`; `seat/seat.ts` holds
the routing rule, `SeatActor` and `inProcessTransport`. The room answers
the three calls from a lease table it keeps in memory. That table is
scaffolding: PR 5 moves it onto the log, and the wire does not change.

**Files.**

- `packages/ambion/src/wire.ts` from the final tree. Keep `Wake` without
  `steer` (PR 7) and `SeatPort` without `cut` (PR 9). Keep the three seat
  calls and their responses whole. Drop the row types (`LeaseRow`,
  `CloseRow`, `CompositionRow`, `CheckpointRow`, `isCheckpoint`): PR 4 and
  PR 5 add them.
- `packages/ambion/src/seat/activation.ts` from the final tree. Trim
  `taken`, `steer` and the `pending` queue to what main's activation does
  with a steer today; PR 7 brings `heard`. Keep `persistTurns` here.
- `packages/ambion/src/seat/hands.ts` from the final tree, whole. It is
  the tools main has in `seat.ts` and `assistant.ts`, moved, and it has no
  dependency on a lease row.
- `packages/ambion/src/seat/seat.ts` from the final tree. Trim `cut`,
  `cutCurrent`, `cutOff` and the race in `take` (PR 9); the deadline
  branch in `renewUntil` (PR 10); the `over` flag and the queue as an
  array (PR 8, take main's single slot). `inProcessTransport` stays.
- `packages/ambion/src/room/lease.ts`: only `activationId`, `draftId`,
  `parseId` and `seatOf`. They are pure, and the room needs the ids now.
- `packages/ambion/src/room/assistant.ts` from the final tree:
  `assertAssistant` and `draftOver`. Main's `assistant.ts` loses the tools
  to `hands.ts` and the activation machinery to the actor.
- `session.ts`: `view`, `commit`, `lease` as in the final tree, but
  `claim`, `end` and `liveSeatOf` read and write a
  `Map<string, { expiry: number }>` in the room. Derive the wake ids from
  the message seq and the seat name. `routing` stays what main has; the
  message does not carry `wakes` yet.
- `host/runtime.ts`: `Transport`, `RunningRoom`, the optional `transport`.
- Tests: `test/wire.test.ts` (rows removed), `test/seat.test.ts` first
  and third tests (the second is PR 9). The existing session, roster and
  presence tests keep passing, which is the point.
- Docs: `docs/agent.md` §5 "What crosses between a seat and its room is
  JSON", with "one call" for the room.

**Extract.** Nothing in the branch is this PR alone. Take the files above
from the final tree and trim; write the in-memory lease table by hand
(about eighty lines). `git diff main..split-source -- packages/ambion/src/seat.ts`
on the branch before `8f0c1bc` shows how main's `seat.ts` became the
actor.

**Watch for.** The Cloudflare package does not exist yet, so nothing
constrains the wire but `wire.test.ts`. Keep every shape plain JSON now;
PR 14 relies on it.

---

## PR 4: The room's shape on the log: composition, closes, the fold

**Scope.** The log gains two row kinds beside the messages:
`ambion/composition`, what a run started with, and `ambion/close`, the
range an exchange turned out to hold. `room/fold.ts` folds the roster, the
reserve, the people and the open exchange from the entries.
`readSession(name).seats()` folds the same composition a running room
folds, so a stopped room says who was in it. The room still holds its
leases in memory.

**Files.**

- `packages/ambion/src/wire.ts`: `CloseRow`, `SeatRow`,
  `CompositionRow`, `Without`.
- `packages/ambion/src/log/log.ts`: the `close` and `composition` entry
  kinds, `Row`, `RowData` and `write()`.
- `packages/ambion/src/room/fold.ts`: `foldRoom` with `composition`,
  `roster`, `reserve`, `people`, `exchange`, `closes`, `messages`,
  `lastSeq`. Trim `leases`, `pending`, `owed`, `floor`, `foldOwed`,
  `judged`, `withAttempts`, `checkpointOf`.
- `packages/ambion/src/room/exchange.ts` and `room/presence.ts` from the
  final tree: `openExchange` over messages and closes; `foldPeople`. The
  `Exchange` shapes move to `types.ts`.
- `packages/ambion/src/room/view.ts`: `seatsOf` and `viewOf` over the
  fold; `handOf` reads the close rows for a draft. Trim what reads
  `owed` (PR 5).
- `session.ts`: `compose()` writes the composition row; `close()` writes
  the close row where main closed the exchange in memory; `state()`
  caches one fold by entry count; `seats()`, `exchange()` and
  `ReadOnlySession.seats()` read the fold.
- Tests: `test/reconcile.test.ts` is PR 5; here, the fold's tests live in
  `test/assistant.test.ts` "a fold" and `test/session.test.ts` "reads
  without one". `test/restart.test.ts` "writes one composition per run"
  can land here with `resumeSession` stubbed as start-over-the-log.
- Docs: `docs/exchange.md` §5 "the close row"; `docs/roster.md` §5 on the
  composition row; `docs/agent.md` §5 "The log is the truth" paragraph,
  with three kinds of entry.

**Extract.** From the final tree, trimmed as above. `git show dece292 --
packages/ambion/src/fold.ts packages/ambion/src/exchange.ts packages/ambion/src/presence.ts`
shows the first version of each, which is close to this PR's.

---

## PR 5: Leases on the log, `decide`, and `resumeSession`

**Scope.** The lease table leaves memory. Every claim, renewal and end is
an `ambion/lease` row; every fact about a seat is a fold; `reconcile()`
folds, decides, writes and sends, and running it twice writes nothing;
`resumeSession(name)` brings a name back over its log, expires the leases
the dead run held, sends the wakes it left, and closes the exchange it
left open. The message carries `wakes`, the seats it woke. The owed
summary is a fold over the closes and the draft leases. The room is
"the log is the truth" from here on.

**Files.**

- `packages/ambion/src/wire.ts`: `LeaseRow` without `since` (PR 12) and
  without `heard` (PR 7); `EndReason` without `abandoned` (PR 11).
- `packages/ambion/src/room/lease.ts` whole, minus `heard`, `since`, the
  `answers`/`cameToNothing` split and the attempts (PR 7): at this PR a
  wake is answered by any ended lease of its id, and an expired lease is
  an attempt that is not retried.
- `packages/ambion/src/room/fold.ts`: `leases`, `pending`, `owed`,
  `foldOwed`, `judged`, `withAttempts`. Trim `floor` and `checkpointOf`.
- `packages/ambion/src/room/reconcile.ts` whole, minus `abandonments` and
  `capped` (PR 11).
- `packages/ambion/src/room/view.ts`: `handOf` over `owed`.
- `session.ts`: `claim`, `end`, `release`, `liveSeatOf` over the fold;
  `reconcileOnce`, `apply`, `close`, `settle`, `arm`, `forget`;
  `resumeSession`, `recover`, `started`; `revoke`, `cut` (the room side
  only), `stop`, `evict`. Trim `checkpoint()` (PR 12), `abandon()`
  (PR 11), the deadline cap in `claim` (PR 10), `heard()` and
  `heardLease()` (PR 6), and the steer on `send` (PR 7).
- `host/runtime.ts`: `wake: { resend, expiry }`, `retry`, `evict`.
- `test/support/transport.ts` (`serializing` and `faultyTransport`),
  `test/support/room.ts` (`crash`, `rowsOf`), `test/restart.test.ts`
  (all but the checkpoint-interval line and the "revoked at its stop"
  test), `test/reconcile.test.ts` (without the cap and `abandoned`
  expectations), `test/lease.test.ts` (without the deadline test),
  `test/session.test.ts` "aborts to a quiet room" as the branch has it.
- Docs: `docs/agent.md` §5 "A seat is seated for the run", "A wake is
  answered by a lease", `resumeSession` in the controls; `docs/exchange.md`
  §5 on a room resumed mid-exchange; `planning/backlog.md` items 26, 31,
  32 as the branch first wrote them.

**Extract.** `git show dece292` is the reference, minus what it did that
PR 3 and PR 4 already did (the wire, the fold's non-lease parts) and plus
`view.ts` from `174aca5`. Taking the final files and trimming per PR 7,
10, 11, 12 is the shorter route.

**Watch for.** This PR has one known gap the branch found later: a
message a live seat heard only through a steer is lost with a crash. PR 7
closes it. Say so in the PR description; it is still a strict improvement
over main, which cannot resume at all.

**Where main and the branch parted, and met.** PR 4 landed on main as
#52 and PR 5 as #53, each with decisions the branch had not made. The
branch adopted them at the merges after each, so the final tree holds:

- Every `SeatRow` carries `identity`, and `CompositionRow.assistant` is a
  `SeatRow`, so `readSession` reads every identity off the log and needs
  no definition.
- A close names the quiet the room decided on: `through` is the record as
  the decision saw it, the row is written wherever the fold still shows
  the same exchange open, and a question that landed after the decision
  opens the next exchange the moment the close lands. `close()` checks
  the exchange and `stopped`, and nothing else.
- A close the storage refuses still answers `settled()` and `quiet()`,
  and the room looks again after the resend window.
- A stopped or dropped handle writes nothing: `stop()` on an evicted room
  returns, `abort()` and `leave()` on it are no-ops, and `quiet()` and
  `settled()` answer at once.
- An expiry the alarm decided is not written over a renewal that landed
  ahead of it, and a draft is handed every close its person is owed, so a
  later close joins the draft under the claim.

Main pins these in `test/assistant.test.ts`, `test/presence.test.ts`,
`test/restart.test.ts` and `test/lease.test.ts` over a `gatedOpener` and
a `faultyOpener` that can fail one entry type. One test of #53 is not on
the branch: "composes nothing for a question the assistant already woke
on" delivers a message to the assistant, which PR 8 refuses at the door
(`test/session.test.ts` "refuses a delivery directed at the assistant").
PR 8 drops that test or rewrites it without the directed delivery. Three
more tests of #53 name PR 5 answers that PR 7 replaces: a wake answered
by any lease of its id, an expiry that closes on the fold that holds it,
and an expiry on resume that wakes nobody again. PR 7 rewrites them as
the branch's `test/reconcile.test.ts` and `test/restart.test.ts` have
them.

---

## PR 6: The chaos tier, the doubt path, and the three faults

**Scope.** The evidence that the log is the truth. A crash at every
append, before the entry lands and after it landed with the confirmation
lost; a SIGKILL of a child process mid-activation; a random walk that
loses and repeats requests, fails writes, and crashes the room. The three
faults the sweep found on the branch are fixed here with their
regressions: a write that landed while its confirmation was lost stayed
invisible until the next write (the doubt path); a visit whose arrival
failed let the person speak; a reconcile pass whose write failed dropped
the alarm. The log's cursor moves to the last entry a read saw.

**Files.**

- `packages/ambion/src/log/log.ts`: `doubt`, `cursor`, `known`, `found`,
  `read`, `open` reading first, `settled`. Take from the final tree, which
  has `9782eb6` in it.
- `session.ts`: `heard()`, `heardLease()`, the `found` callback,
  `visit()` deleting the visit on a failed arrival, `reconcileOnce`
  re-arming at `now + resend` on a failed write, `messages()` awaiting
  `settled()`, `evict()` closing the log and clearing listeners
  (`3fb7efd`).
- `test/support/{cast,chaos,child}.ts`, `test/chaos.test.ts`,
  `test/property.test.ts`, the `tappedOpener` and `faultyOpener` in
  `test/support/storage.ts`, `test/support/clock.ts` settling over real
  time (`ed04f13`), the `inherited` options in `invariants.ts`,
  `test/log.test.ts` "in doubt" tests.
- `package.json` `chaos` script; `CLAUDE.md` command; `docs/toolchain.md`
  §8 "The chaos tests are the evidence"; `docs/agent.md` §6.

**Extract.** `git cherry-pick -x 8bd7a08 ed04f13 3fb7efd 9782eb6` in that
order; expect conflicts in `session.ts` against PR 5's trimmed version,
and in `chaos.test.ts` on the `sqlite` storage (drop it; PR 13 adds it).
`chaos.ts` uses `liveLeases` with `foldLeases` and `isLive`: both exist
after PR 5.

---

## PR 7: Wakes name every seat, leases carry `heard`, retries

**Scope.** The routing redesign. `wakes` on a message names every seat it
reaches: the idle ones its reach wakes, and every seat holding a live
lease. The seat side decides between a fresh activation and a steer into
the running one, and the wake carries the rendered line. Every lease row
carries `heard`, the seq the activation has taken, so the log says which
wakes an activation answered. A lease that expired or failed without
speaking is one attempt, and the room wakes the seat again after the
backoff, with the same policy the summaries use. The live resume test
proves it on a real model.

**Files.** `wire.ts` (`Wake.steer`, `heard` on rows, `Lease.heard`),
`room/lease.ts` (`heard`, `answers`, `cameToNothing`, `statusOf` with
attempts and `notBefore`, `WakeOptions`), `room/fold.ts` (`FoldOptions`,
`foldOwed` over `wakes`), `room/reconcile.ts` (`ready`, `due`, the
resend of pending wakes), `seat/activation.ts` (`taken`, `steer`, the
`pending` seqs, `moved`), `seat/seat.ts` (the steer branch of `wake`,
`renew` with `heard`), `session.ts` (`routing` with the at-work seats,
`send` with the steer line, `claim` and `end` with `heard`, `due`).
Tests: the branch's changes to `lease`, `reconcile`, `restart`, `session`,
`property` and `wire` tests, `test/live/resume.test.ts`,
`test/live/loop.test.ts` (`2b0c65b`). Docs: `docs/agent.md` rule 2 and
§5 "A wake is answered by a lease that heard it"; `docs/exchange.md` §5.

**Extract.** `git cherry-pick -x 20dfe55 2b0c65b`, plus
`test/live/resume.test.ts` from `174aca5`. `20dfe55` also touches the
Cloudflare package; drop those hunks, PR 14 takes the final files.

**Where main and the branch parted, and met.** PR 7 landed on main as
#56 with the same outcomes and a different mechanism. Main derives who
heard what from where the rows sit: `LeaseState.since`, `until` and
`heardThrough` are the `after` of the first row, the ended row and the
last running row, and `reached` adds every seat at work when the message
landed. The branch keeps `heard` on every lease row and names the seats
at work in `wakes` on the message. It keeps them because PR 12 replaces
the rows with a checkpoint whose `after` is the floor, so a seq derived
from the row's position is lost there, and the deadline of PR 10 reads
the claim time off the row. The branch adopted main's decisions:

- A lease that expired or failed answers nothing it heard, whatever it
  said. Its words stay on the record, and the seat reads them at the next
  attempt. The `spoke` rule is gone from `pendingWakes`.
- A lease that stood down answers through the seq its release said. The
  branch's release row carries `heard` for it; main reads the last
  renewal's `after`. `lease.test.ts` "answers a question that landed
  between its last renewal and its release" proves it with the `hold`
  fault.
- The cast (`Cast`, `steady`, `troubled` in `test/support/cast.ts`) and
  `test/hosts.test.ts`, the handover under load and the split the design
  forbids, run on the branch unchanged; `pnpm chaos` runs the handover at
  every write.

Main hides a wake at the cap inside `pendingWakes`; the branch reports it
and PR 11 writes it off as a lease ended `abandoned`. PR 11 keeps that.
Main's `session.test.ts` aborts the room after the one failed activation;
the branch's version runs the three attempts to the cap and stays.

---

## PR 8: The review fixes

**Scope.** Three faults and three edges a review pass found: a revoked
draft kept the summary owed under an id the revoked row had taken, so the
room resent it for ever; the seat actor could run two activations at once
when a wake landed during a release, and its queue held one id; a start
whose composition the record refused kept the name; a delivery could be
directed at the assistant; a commit from a lease that ended was answered
`missed` before `stale`; `joinLater` was dead code and `atWork` rescanned
every lease per seat.

**Files.** `room/fold.ts` (`STOOD_DOWN` with `revoked`, `joinLater`
deleted), `seat/seat.ts` (`Current` with `over`, the queue as an array,
`enqueue`, `run` resolving when the queue is drained), `session.ts`
(`free`, `deliverFrom` refusing a seat at `none`, `routing` as a set,
`atWork` as a set, the stale check ahead of the queue in `commit`).
Tests: `test/seat.test.ts` first and third tests, the assistant and
restart "writes off a draft the host revoked" tests, the three session
tests. Docs: `docs/agent.md` §5 abort bullet, `docs/assistant.md` §6.

**Extract.** `git cherry-pick -x ef252c1`. It applies on PR 7 with at most
whitespace conflicts.

---

## PR 9: `cut` on the wire

**Scope.** The room reaches a seat through two calls. `cut` names an
activation whose lease the room ended, so the seat side stops it now, in
process and over RPC, and moves on even when the run ignores the abort.
`session.ts` talks to ports only.

**Files.** `wire.ts` (`SeatPort.cut`), `seat/seat.ts` (`cut`,
`cutCurrent`, `cutOff`, the race in `take`, `renew` returning
`'stale' | 'lost' | number`, `renewUntil` cutting on `stale` and arming a
cut at the held expiry on `lost`), `session.ts` (`cut` ending the leases
then calling `port.cut`, no `instanceof SeatActor`),
`test/support/transport.ts` forwarding `cut`, `test/seat.test.ts`
second test. Docs: `docs/agent.md` §5 "The room reaches a seat through
two".

**Extract.** From `3517d45`: `git show 3517d45 -- packages/ambion/src/seat.ts packages/ambion/src/wire.ts packages/ambion/src/session.ts`
and take the hunks that name `cut`. The `lost` branch of `renewUntil`
belongs here, not to PR 10: a lost renewal leaves the lease to expire and
the actor cuts at the known expiry.

---

## PR 10: A deadline on every activation

**Scope.** No lease runs past `runtime.wake.deadline` from its claim. The
room caps the expiry of every claim and renewal at `since + deadline`; the
lease then expires on the alarm the room already has, and the fold counts
it as an attempt. The seat side notices a renewal that moves the expiry
nowhere and cuts the activation at that expiry. Default ten minutes.

**Files.** `room/lease.ts` (`LeaseState.since`, folded from the first
row), `host/runtime.ts` (`wake.deadline`), `session.ts` (`claim`
computing `expiry = min(now + expiry, since + deadline)`), `seat/seat.ts`
(`renewUntil`: `renewed <= held` arms the cut at `renewed`),
`test/lease.test.ts` "expires an activation at its deadline". Docs:
`docs/agent.md` §5 lease paragraph.

**Extract.** From `3517d45`, the hunks that name `deadline` or `since`.
About sixty lines of source.

---

## PR 11: A row at the cap

**Scope.** The fold reports every pending wake and every owed draft with
its attempts; the cap is the room's decision. `decide` returns
`abandoned`: for each wake or draft at `retry.attempts`, the attempt the
room does not make, ended `abandoned` before it starts. The row answers
the wake or the close, and the host hears an `abandoned` event. Backlog
item 28 closes its first half.

**Files.** `wire.ts` (`EndReason` gains `abandoned`), `types.ts` (the
`abandoned` event), `room/lease.ts` (`WakeOptions` loses `attempts`;
`statusOf` stops filtering at the cap), `room/fold.ts` (`STOOD_DOWN`
gains `abandoned`; `foldOwed` stops filtering at the cap),
`room/reconcile.ts` (`abandonments`, `capped`, `Decision.abandoned`, the
close withheld when an abandonment is pending, `dueWakes` and
`retryTimes` skipping capped ones), `session.ts` (`abandon`, `WRITES_OFF`,
`end` accepting `abandoned` for an id never claimed). Tests: the two cap
cases in `test/reconcile.test.ts`, the `abandoned` decision in "closes
nothing once stopped". Docs: `docs/agent.md` §5 and the event list,
`docs/assistant.md` §16, `planning/backlog.md` item 28.

**Extract.** From `3517d45`, the hunks that name `abandon` or `capped`.

---

## PR 12: The checkpoint

**Scope.** Every `runtime.checkpoint.rows` rows, the room writes an
`ambion/checkpoint` row: the composition, the closes and the leases a
later fold still reads, behind a floor below which every wake was
answered. The fold reads a checkpoint in place of every row before it,
and ignores wakes below the floor; the log drops those rows from memory
after the replay and after each write. The rows stay on the storage, and
a checkpoint the room cannot read is ignored. Backlog item 26 closes.

**Files.** `wire.ts` (`CheckpointRow`, `isCheckpoint`, `since` on
`LeaseRow`), `log/log.ts` (the entry kind, `compact`,
`rowsSinceCheckpoint`), `room/fold.ts` (`sorted` reading a checkpoint,
`floor` on `RoomState`, `checkpointOf`, `floorOf`, `reads`, `named`,
`leaseRow`), `room/lease.ts` (`since` off a checkpoint row),
`host/runtime.ts` (`checkpoint.rows`), `session.ts` (`checkpoint()` after
a pass that writes nothing), `test/checkpoint.test.ts`,
`test/restart.test.ts` with `checkpoint: { rows: 3 }` in `world()`.
Docs: `docs/agent.md` §5 "A checkpoint bounds what a fold costs" and five
entry kinds; `planning/backlog.md` item 26.

**Extract.** From `3517d45`, the hunks that name `checkpoint`, `floor`,
`compact` or `since` (the `since` fold line lands in PR 10; the
checkpoint's `since` on the row lands here).

---

## PR 13: The SQLite storage in the core

**Scope.** `host/sqlite.ts`: Pi's `SessionStorage` over any SQLite a host
reaches through two calls, `run` and `all`. The test support wraps
`node:sqlite`, and every scenario, the restart suite and the widened
chaos sweep run on a third storage. This is the whole of what a host over
a local SQLite file needs from the core.

**Files.** `packages/ambion/src/host/sqlite.ts` whole, `index.ts`
exports, `test/support/storage.ts` (`nodeSql`, `sqlite`, the three
storages), `test/matrix.test.ts` header, `test/chaos.test.ts` widened
sweep, `docs/toolchain.md` §8 on three storages, `docs/agent.md` §5
storage paragraph.

**Extract.** `git checkout split-source -- packages/ambion/src/host/sqlite.ts`
is the file; it is `packages/cloudflare/src/storage.ts` from `3defaf3`
over the `Sql` interface. Take the `storage.ts` support hunks from
`3517d45`.

---

## PR 14: The Cloudflare adapter

**Scope.** A room as Durable Objects: one object holds the room over the
core's SQLite storage on `ctx.storage.sql`, one object holds each seat and
runs one actor inside one alarm, RPC is the wire with `cut` over it, the
object's alarm is the clock. Private, tested inside workerd, deployed by
nothing.

**Files.** `packages/cloudflare/**` from the final tree, whole. It needs
`cut` (PR 9) and `sqliteSessions` (PR 13), and `SeatContext` with a clock
and a catalog (PR 3's final shape). `knip.json`, `CLAUDE.md` row,
`docs/toolchain.md` §1 and §8 on the workerd tier.

**Extract.** `git checkout split-source -- packages/cloudflare knip.json`
then the doc rows. `3defaf3` is the first version and is not the one to
take: `storage.ts` became a wrapper and `seat-object.ts` gained `cut`.

---

## PR 15: The demo that crashes, and its report

**Scope.** The runnable example drops its runtime as the first answer to
Sam's question lands and resumes it in a second runtime over the same
log; the report shows the leases the dead run held, when they expired,
the wakes sent again, and the message the exchange closed into.

**Files.** `examples/site/src/demo.ts`, `scripts/report.mjs`,
`demos/README.md`, `demos/2026-09-09-the-room-comes-back.html`
(regenerate on the branch with a key: `pnpm --filter site demo` then
`node scripts/report.mjs`).

**Extract.** `git cherry-pick -x 4474de1 346cf31`; regenerate the report
rather than carrying the branch's HTML, since the log format changed after
it was captured (the checkpoint row, `abandoned`, `since`).

---

## Where each final symbol first appears

| Symbol                                                   | PR  |
| -------------------------------------------------------- | --- |
| `Runtime`, `createRuntime`, `Clock`, `SessionOpener`     | 1   |
| `RoomLog.commit`, `readThrough`, keys                    | 2   |
| `Wake`, `SeatRoom`, `SeatPort`, `SeatActor`, `hands`     | 3   |
| `CompositionRow`, `CloseRow`, `foldRoom`, `openExchange` | 4   |
| `LeaseRow`, `pendingWakes`, `decide`, `resumeSession`    | 5   |
| `RoomLog.read`, `found`, `cursor`, `World`               | 6   |
| `Message.wakes` for seats at work, `heard`, `Wake.steer` | 7   |
| `SeatPort.cut`                                           | 9   |
| `wake.deadline`, `LeaseState.since`                      | 10  |
| `abandoned`                                              | 11  |
| `CheckpointRow`, `checkpointOf`, `RoomLog.compact`       | 12  |
| `Sql`, `sqliteSessions`                                  | 13  |
| `RoomObject`, `SeatObject`, `sqlOver`                    | 14  |

## Checks before each PR is opened

1. `pnpm format && pnpm check` is green.
2. `git diff main..HEAD --stat` holds only the files the PR names.
3. Every doc link points at a file the PR's tree has.
4. The PR description names the one idea, the tests that pin it, and
   what a later PR adds on top.
