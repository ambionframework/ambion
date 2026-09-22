# Next: the scope for 0.2.0

> **The compatibility rule since 0.1.0.** 0.1.0 shipped on 2026-09-21 from
> commit 4026bdf, with ten packages on npmjs. Its public shape stands until
> the 0.2.0 tag. Every change to the main entry and to the journal bodies is
> additive, unless an item below names a deliberate change.
>
> - **The main entry is `@ambionframework/ambion`.** Its exports are the
>   names in `packages/ambion/test/package.test.ts`. The host entry
>   `/hosting` and the conformance entry follow the same rule.
> - **The journal bodies are the room event vocabulary** in
>   `packages/ambion/src/journal/events.ts`. `journal/validate.ts` checks
>   them and `room/fold.ts` reads them.
> - **Additive means one of:** a new export, or a new optional body field.
>   A new entry kind, a new member of the message union, or a new member of
>   a public outcome union is a deliberate change. It needs a new golden
>   journal and a review.
> - **The rule forbids:** to remove or rename an export, to remove or
>   rename a body field, to change a field type or its meaning, and to
>   remove an entry kind.
> - **One body refuses new fields.** The `close` object inside a `cancel`
>   entry has `additionalProperties: false`. A new field there breaks an
>   older reader.
> - **Three guards catch a violation:** the export snapshot
>   (`test/package.test.ts`), the golden journals (`test/golden.test.ts`),
>   and body validation (`test/journal-validation.test.ts`). A red diff on
>   one of them is a violation. Do not write the snapshot again.
> - **The storage promise** is in the "Storage compatibility" paragraph of
>   [durability.md](../docs/durability.md). A journal that 0.1.0 wrote stays
>   readable.

This file is the whole plan for 0.2.0: the scope, the order of the work,
the evidence each step needs, and the reason for each item.
[backlog.md](backlog.md) holds everything after 0.2.0. The
[changelog](../CHANGELOG.md) records what 0.1.0 shipped.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, and
[Technical facts](../docs/technical-facts.md) holds the key facts and what
is new. 0.1.0 makes a room a place that agents and people use when a
person asks a question. 0.2.0 makes a room useful between questions: an
event or a clock wakes it, and it hands work to another room. The same
release makes the kernel cheaper to change, so these two features land on
one owner per mechanism.

## The scope

**Four themes, each with the acceptance it must meet on the tagged
commit.** The phases below deliver them; the items explain them.

| Theme                     | Acceptance                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W Wake sources            | A room wakes a seat on a notice from a resource and on a timer that the journal records. A restart re-arms every timer. An `awaiting` exchange expires on a stated bound.                          |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database.     |
| M One owner per mechanism | Each duplication that items M1 to M6 name has one owner. The rules file carries only rules that gate a write. The journal package owns the one crash-safe append loop. Each doc fact has one home. |
| R A repeatable release    | A trusted CI workflow publishes the release to npmjs with provenance. The dev build stamp follows the next release.                                                                                |

**The tag waits for the P0 and P1 steps.** A P2 step that is open when the
last P1 step closes moves to the backlog. It does not hold the tag.

**Four deliberate changes, one review.** The release changes the journal
vocabulary or a stored format in four places. Each change lands with its
own golden journal. Phase 4 step 1 reviews the four together against the
0.1.0 journals before the tag.

| Change                                             | Item | Kind                        |
| -------------------------------------------------- | ---- | --------------------------- |
| The notice message kind                            | W1   | A new message union member  |
| The timer entry                                    | W2   | A new entry kind            |
| An `awaiting` outcome that names a room            | D1   | A new outcome union member  |
| One idempotency key in the pi-journal session file | M3   | A stored field that retires |

**Deployment models.** The same rules serve four placements.

| Model                         | Placement                         | Persistence               | Support                                                            |
| ----------------------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Embedded Node application     | Room and executors in one process | In-memory journals        | Supported for development, tests, and ephemeral lifetimes          |
| Persistent Node service       | An application-managed service    | SQLite journals           | Supported; the workbench example is the reference host             |
| Separate room and agent hosts | Calls cross the JSON protocol     | Each host chooses storage | Extension contract with a published conformance suite              |
| Cloudflare Durable Objects    | One object per room, one per seat | Each object's SQLite      | Publishable adapter tested in workerd; deployment commands pending |

## Out of scope

**These wait in the [backlog](backlog.md).** The backlog states the
condition that brings each one back.

- **The checkpoint entry.** The incremental projection keeps a new
  question at the same cost at any history length
  ([envelope.md](../docs/envelope.md)). A checkpoint is a format change
  with no measured need. Phase 2 step 4 measures the resume cost of a room
  that a timer wakes for a long time. That number decides the checkpoint.
- **A generated API reference.** It adds a build step and a CI check, and
  the typed README examples already hold the surface.
- **The evals package.** PR #153 is a draft, conflicts with main, and
  carries its own list of open work.
- **The open proofs.** The stop-loop and pass measures, unique roster
  names, `seatLive`, and `storedIdAccepted` remove no defect today.

## Decisions taken

- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages.
- **Speech enters the record through `say` only**, on every executor.
- **A notice is the scheduler ingress.** The application owns its
  schedule and delivers a notice through one host call. The kernel adds no
  scheduler.
- **The journal records a timer, and the host runs it.** The host owns the
  clock. A restart reads the timer entries and arms them again.
- **Delegation has no task database.** A working room is a room, and a ref
  connects the two.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs.
- **Two public names stay.** `RoomObject.exchange` saves the snapshot
  payload over the Durable Object RPC boundary. `speakOnce` is the minimal
  reference that a transport author needs. A removal of either adds rules
  for callers, so neither is in the release.
- **`@ambionframework/cli` is removed.** It shipped in 0.1.0 as one of ten
  published packages, and it provided `ambion new` and `ambion dev`. It
  also carried its own Node floor, `>=26.4.0` for `@opentui/core`'s FFI
  bridge, onto every other package, whether or not that package needed it.
  Nine packages remain, each needing only Node `>=22.19.0`.
  `examples/workbench` keeps the `>=26.4.0` floor, since it depends on
  `@opentui/core` directly.

## The model to preserve

| Concern                                                       | Owner                 | Rule                                                                 |
| ------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------- |
| Definitions, executors, tools                                 | Application code      | Fixed per room run; no executable code in the journal                |
| Membership, presence, messages, exchanges, claims, references | Room journal          | Pure interpretation of confirmed entries                             |
| Model loops, harness sessions, activation steps               | Executor              | One session per activation; steps to the trace, speech through `say` |
| Files, tables, instruments, and their change logs             | Application resources | Independent of journal transactions; stamped with provenance         |
| Timers, runners, subscriptions, live handles                  | Host                  | Armed again from the journal after restart                           |
| Identity selection, discovery, hosting state, delivery outbox | Application           | Explicit entry and stable retry keys                                 |

**Judge a change by the obligation it removes.** Fewer exports are useful
when callers need fewer rules. A rename earns its place only when one name
means two things or two names mean one.

## The order of work

**Three lanes run at once.** A step names the steps it needs; a step with
no "Needs" line starts now. **P0** blocks the tag. **P1** carries the
release story. **P2** moves to the backlog when it is late.

| Lane | Chain                                                     | Priority |
| ---- | --------------------------------------------------------- | -------- |
| A    | Phase 1, then phase 2, then phase 3                       | P0       |
| B    | Phase 4: 2 and 3 now; 1 after the four deliberate changes | P1       |
| C    | Phase 5: every step now                                   | P1, P2   |

**The critical path is the kernel cleanup, the notice, the timer, then the
delegation.** Phase 1 comes first because phases 2 and 3 change the same
room files and the same rules file.

### Phase 1. Consolidate the kernel (P0)

**Goal:** the wake sources and the delegation land on one owner per rule.

- [ ] **1.** Kernel decision layers: relocate `evolve`, one retry matcher,
      one summary narrowing, one recorded envelope base, and one home for
      the summary text. (M1)
- [ ] **2.** The rules sweep: a keep-or-withdraw list for every exported
      rule, and one `draftsClose` rule for both draft counts. Needs 1. (M2)
- [ ] **3.** Each doc fact has one home. (M6)

**Evidence:** `pnpm check`; `pnpm rule:check` on the rules file and
`pnpm check:lemmascript`; the keep-or-withdraw list in
[docs/formal.md](../docs/formal.md).

### Phase 2. Wake sources (P0)

**Goal:** an event or a clock wakes a room, as a person does.

- [ ] **1.** The notice: a message kind with a ref and no author, routed
      by attention, with its golden journal. (W1)
- [ ] **2.** The notice host call with a stable key, its durable start, and
      its restart semantics. Needs 1. (W1)
- [ ] **3.** The timer entry: a scheduled wake and the `awaiting` expiry,
      armed again on restart. Needs 2. (W2)
- [ ] **4.** The Cloudflare adapter runs a timer through its alarm, and a
      measurement records the resume cost of a room with many timer
      wakes. Needs 3. (W2)

**Evidence:** a scripted test and a chaos case for each step; a kill
between the timer entry and the wake keeps the wake; the docs that call
timers future work say what shipped.

### Phase 3. Delegation by reference (P0)

**Goal:** one room hands work to another and gets one answer back.

- [ ] **1.** The working-room ref and the delegating message. Needs phase
      2 step 1. (D1)
- [ ] **2.** The `awaiting` outcome that names the working room, and the
      return message with a ref. Needs 1. (D1)
- [ ] **3.** A read of the status of the delegated work through the
      exchange the ref opened. Needs 2. (D1)
- [ ] **4.** Close PR #151 with a comment that names the new route. Needs 3. (D1)

**Evidence:** the workbench delegates one question to a second room; a
restart in the middle keeps the work.

### Phase 4. Release (P1)

**Goal:** the release repeats without the owner's machine.

- [ ] **1.** The review of the four deliberate changes: each golden
      journal, a 0.1.0 journal read by the 0.2.0 fold, and the changelog
      entry. Needs phase 2 step 4, phase 3 step 4, and phase 5 step 1. (R1)
- [ ] **2.** The dev build stamp derives its base from the last tag.
      (R1)
- [ ] **3.** An npmjs release that a trusted CI workflow runs with
      provenance. Needs 2. (R1)

**Evidence:** a release from CI installs without a token; the dev stamp
after the 0.2.0 tag sorts above 0.2.0; the golden suite reads every 0.1.0
journal.

### Phase 5. Package hygiene (P1 and P2)

**Goal:** the journal, workspace, adapter, and conformance packages keep
one copy of each mechanism.

- [ ] **1.** One crash-safe append loop in `packages/journal`, and one
      idempotency key in pi-journal. P1. (M3)
- [ ] **2.** The workspace logs: land PR #171, then one record path, one
      file list, one table, and one call envelope. P1. (M4)
- [ ] **3.** One set of scripted room fixtures in the conformance suite.
      P2. (M5)

**Evidence:** `pnpm check`; `pnpm chaos` and the restart suite for step 1;
a pi-journal file that 0.1.0 wrote reads as before.

## The items

Each item states the problem, the solution, and the impact. The file and
line references are from `main` at `713761a`.

### W. Wake sources

**W1. A notice from a resource.** A room wakes only when a person speaks,
so an agent cannot react when a brief changes or a run completes. Add a
message kind with a ref and no author, routed by attention. One host call
delivers it with a stable key, so a retried delivery lands once. An
application scheduler calls the same host call, so the kernel needs no
scheduler of its own. A notice opens no exchange by itself and arrives
through no hidden timeout.

**W2. A timer that the journal records.** Nothing wakes a room on a clock,
and an `awaiting` exchange waits for ever. A timer entry records the due
time and the wake it owes. The host arms it and writes the wake when it is
due. A restart reads the open timer entries and arms them again, so a
crash loses no timer. The `awaiting` expiry is a timer that the close
schedules. If the expiry writes on the `awaiting` outcome,
`exchangeOutcome` gates a write and stays a verified rule (M2).

### D. Delegation

**D1. Delegation by reference.** PR #151 stored tasks in the journal and
scanned every task on each reconcile pass. Use a ref and the `awaiting`
outcome. The delegating message carries a ref to
`ambion://room/<working>/message/<from>`. The origin exchange closes as
`awaiting` that room. The working room closes with one message that
carries a ref back. Status is a read of the exchange that the referenced
message opened.

### M. One owner per mechanism

**M1. Kernel decision layers.** Test helpers and second narrowings sit in
the files that decide commands into events.

- Move `evolve` (`room/transition.ts:102`) to test support. It has no
  production caller, and it is the only reason `transition.ts` imports
  three fold functions.
- Add `saidContentMatches` to `room-host/core.ts`. Call it from
  `contributionMatches` (`room-host/control.ts:53`) and `deliveryMatches`
  (`room-host/people.ts:66`).
- Delete `summaryOutcome` (`room/exchange.ts:362`). Call
  `summaryCompletion` from `closedExchangeView`.
- Add an internal `Recorded` base for `seq`, `key`, `activationId`,
  `wakes`, and `at`. `SpokenMessage`, `PresenceMessage`, and
  `SummaryMessage` (`types.ts:155`, `193`, `236`) extend it. The union
  keeps its shape.
- Move `SUMMARY_DUTIES` and `summaryToolDescription` from
  `execution/summary.ts` into `render.ts`, and delete the file. Let the
  assistant (`assistant/src/index.ts:39`) reference the shared duties and
  keep only its own verification rules.

**M2. The rules sweep.** A proof pays for itself on a rule whose fault
loses or duplicates the record ([docs/formal.md](../docs/formal.md)).
Classify each exported rule in `room/rules.verified.ts` by that test, and
withdraw the rules that only shape a read view. Decide `exchangeOutcome`
(`rules.verified.ts:403`) after the W2 design: it stays when the `awaiting`
expiry reads it. Add `draftsClose(id, through, writer)`: `fold.ts`
`draftedOver` counts a draft for any seat, and `exchange.ts` counts only
the named writer's. A journal from another writer folds two answers today.
Record the list in [docs/formal.md](../docs/formal.md).

**M3. One crash-safe append loop.** The `Journal` class,
`JournalAuditSession` (`pi-journal/src/index.ts`), and `MetadataJournal`
(`cloudflare/src/storage.ts`) each write a serial queue, a cursor replay,
and an in-doubt recovery by hand.

- Extract one append primitive in `packages/journal` with an `apply` and a
  `recover` callback. Rebuild the two other classes on it, and keep every
  stored record byte-identical.
- Delete `entryMutations` and `usedIds` (`pi-journal/src/index.ts:58`),
  which hold a dead index and a copy of `entriesById`.
- Replace `positionRead` (`journal/src/storage.ts:52`) with the verified
  `scanned` rule at its two callers.
- Retire the random mutation `id` (`pi-journal/src/index.ts:226`) and the
  `mutations` map. The caller's `source.id` answers the in-doubt question.
  Keep `sameEntry`, which refuses a colliding id with other content. Take
  the same decision for `MetadataJournal`.
- Make `envelope` (`journal/src/journal.ts:208`) throw for a known kind
  with a malformed seq. A skip hides corruption.

**M4. The workspace logs.** PR #171 fixes a regression: a directory
failure that clears on retry is written as an oversized entry. Land it
first, because the rest edits the same code.

- One best-effort record path and one `reportError` in `log.ts`, for
  `audit.ts`, `changes.ts`, and `mirror.ts`.
- One rotated-file list beside `rotatedName` (`log.ts:45`), for
  `changes.ts:88` and `mirror.ts:98`.
- One import-free Markdown table module for `sql.ts:237` and
  `sql-resource.ts:283`.
- One private `callEnvelope` in `tools.ts` for the two copies of the
  provenance prefix.

**M5. The conformance suite.** `conformance.ts` and
`conformance-executor-room.ts` each hold their own question, participants
block, and `stale` constant.

- The shared question, participants block, and `stale` constant of
  `conformance.ts` and `conformance-executor-room.ts` move to
  `conformance-support.ts`. `until` accepts an async predicate, and
  `traceWhenEnded` uses it.

**M6. Each doc fact has one home.** The positioning rule in
[CLAUDE.md](../CLAUDE.md) states that every page states a fact once.

| Fact                                   | Home                 | Where it repeats                    |
| -------------------------------------- | -------------------- | ----------------------------------- |
| The legacy-refusal and resume rule     | `room.md`            | `summary.md:144`, `roster.md:100`   |
| The table of the two spans             | `room.md`            | `exchange.md:14`                    |
| The list of what is new                | `technical-facts.md` | The claim at `technical-facts.md:3` |
| The assistant seats normalization      | `assistant.md`       | `roster.md:35`                      |
| The tool-call provenance subset        | `resources.md`       | `agent.md:84`, `workspace.md:89`    |
| The owner rules and two test citations | The owning pages     | `patterns.md:33`, `patterns.md:45`  |

The README keeps the headline of what is new. `technical-facts.md` keeps
the list.

### R. Release

**R1. A repeatable release.** The 0.1.0 release ran from one machine with
a passkey and a token, and `DEV_BASE` in `dev-release.yml` is a literal. A
trusted workflow with `id-token: write` publishes with provenance and
needs no token on a laptop. The dev stamp reads its base from the last
tag. The review of the deliberate changes is the last gate before the
tag.
