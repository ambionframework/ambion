# Next: the scope for 0.2.0

> **No compatibility promise before 1.0.0.** 0.1.0 shipped on 2026-09-21
> from commit 4026bdf, with ten packages on npmjs. Until 1.0.0, any release
> may change any export, entry point, journal body, stored format, or
> package API.
>
> - **A change carries no compatibility path.** Add no re-export, no
>   deprecated alias, no reader for an older format, no upgrade step, and
>   no compatibility test.
> - **The changelog names each change** to an export, a journal body, or a
>   stored format.
> - **The guards pin the current surface.** The export snapshot
>   (`test/package.test.ts`), the golden journals (`test/golden.test.ts`),
>   and body validation (`test/journal-validation.test.ts`) catch a change
>   that nobody intended. A deliberate change updates them in the same
>   commit.

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

| Theme                     | Acceptance                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W Wake sources            | A room wakes a seat on a notice from a resource and on a timer that the journal records. A restart re-arms every timer. An `awaiting` exchange expires on a stated bound.                                                                                                       |
| D Delegation by reference | A working room is a room. A message that carries a ref to it delegates the work. The origin exchange awaits the working room, and one message with a ref returns the result. No task database.                                                                                  |
| M One owner per mechanism | Each duplication that items M1 to M7 name has one owner. The rules file carries only rules that gate a write. The journal package owns the one crash-safe append loop. Each doc fact has one home. A workspace backend implements an interface that a conformance suite checks. |
| R A repeatable release    | A trusted CI workflow publishes the release to npmjs with provenance. The dev build stamp follows the next release.                                                                                                                                                             |

**The tag waits for the P0 and P1 steps.** A P2 step that is open when the
last P1 step closes moves to the backlog. It does not hold the tag.

**Four format changes.** The release changes the journal vocabulary or a
stored format in four places. Each change lands with a golden journal of
the new shape. The changelog names each one.

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
- **A backend profile and concurrent operations.** The workspace owner
  runs one operation at a time for every agent (`resource.ts:87`). A
  backend that keeps agents apart could run two at once. The same holds
  for the identity that writes the audit log. Both change the owner, and
  only the workstation backend (PR #268) needs them.

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

| Lane | Chain                                                 | Priority |
| ---- | ----------------------------------------------------- | -------- |
| A    | Phase 1, then phase 2, then phase 3                   | P0       |
| B    | Phase 4: 2 and 3 now; 1 after the four format changes | P1       |
| C    | Phase 5: 1 to 3 now; 4 after 2                        | P1, P2   |

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

- [ ] **1.** The changelog entry for 0.2.0: each format change with its
      golden journal, and each export that changed or went. Needs phase 2 step 4, phase 3 step 4, and phase 5 step 1. (R1)
- [ ] **2.** The dev build stamp derives its base from the last tag.
      (R1)
- [ ] **3.** An npmjs release that a trusted CI workflow runs with
      provenance. Needs 2. (R1)

**Evidence:** a release from CI installs without a token; the dev stamp
after the 0.2.0 tag sorts above 0.2.0.

### Phase 5. Package hygiene (P1 and P2)

**Goal:** the journal, workspace, adapter, and conformance packages keep
one copy of each mechanism.

- [ ] **1.** One crash-safe append loop in `packages/journal`, and one
      idempotency key in pi-journal. P1. (M3)
- [ ] **2.** The workspace logs: land PR #171, then one record path, one
      file list, one table, and one call envelope. P1. (M4)
- [ ] **3.** One set of scripted room fixtures in the conformance suite.
      P2. (M5)
- [x] **4.** The workspace as an interface: a conformance entry, a
      contract with no `destroy()` and no change log, a neutral layer that
      owns the tools, their guidance, and the environment helpers, and one
      entry for each binding. Needs 2. P1. (M7)

**Evidence:** `pnpm check`; `pnpm chaos` and the restart suite for step 1;
the memory and
directory backends pass the workspace conformance entry, and
`dist/index.mjs` of the workspace package imports neither `just-bash` nor
`node:sqlite`.

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
  `audit.ts` and `mirror.ts`. M7 removes `changes.ts`, so this item leaves
  it as it is.
- One rotated-file match beside `rotatedName` (`log.ts:45`), for
  `mirror.ts:98`.
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

**M7. The workspace as an interface.** `packages/workspace` holds a
neutral layer and one implementation behind one entry. The resource
contract, `openWorkspace`, the tool binding, the logs, the mirror, and the
`sql` tool run over Pi's `ExecutionEnv` alone. The root entry still loads
just-bash (`index.ts:35`) and `node:sqlite` (`index.ts:55`). A backend
repeats rules that the neutral layer owns, and the contract holds two
features that do not hold on every backend. A second backend, such as the
workstation in PR #268, repeats those rules and implements those features
again. M4 edits the same files, so M7 starts after it.

The contract gets smaller:

- **A conformance entry.** `@ambionframework/workspace/conformance` holds
  the scenario matrix of `test/support/backends.ts` and the `ExecutionEnv`
  rules that the tools need: a rename that replaces its target, a
  recursive create, a forced remove, the file error codes, `~` expansion,
  an abort apart from a timeout, and the bounded output view. Any backend
  runs it, and the memory and directory backends run it first.
- **No `destroy()`.** Nothing outside the tests calls it. The SQL resource
  answers it with a no-op (`sql-resource.ts:161`). On a shared server it
  would delete the files of every account. `WorkspaceResource`,
  `ResourceBackend`, and `SqlResource` lose it. The owner keeps three of
  its five phases (`resource.ts:32`), and the directory walk of
  `directoryBackend` goes (`just-bash.ts:261`). A host deletes the data
  that it owns.
- **No change log.** The change log records a `write` or an `edit` call
  only. A change through `bash`, `sql`, or a script never reaches it
  ([Record what changed](../docs/workspace.md#record-what-changed)). The
  audit log already records every tool call with its arguments and its
  provenance. `changes.ts`, the `changes` option, `workspace.changes()`,
  and `WorkspaceBackend.changedPaths` (`just-bash.ts:218`) go.
- **No `identity`.** No backend reads `WorkspaceAgent.identity`
  (`resource.ts:4`), and each one keys on `name`. `WorkspaceAgent` keeps
  `name` alone. The tool context still passes its agent. The host agent
  (`workspace.ts:77`), the tests, and the examples in `workspace.md` and
  `resources.md` stop setting the field.

The neutral layer owns what every backend needs:

- **One default tool set.** The neutral layer owns `read`, `write`,
  `edit`, `bash`, and `sql` (`justBashTools`, `just-bash.ts:127`). A
  backend adds its own tools and does not list the defaults again.
- **One tool guidance.** `JUST_BASH_GUIDANCE` (`just-bash.ts:106`)
  describes the five default tools and the shared database beside the
  just-bash shell. The neutral layer writes the part about the tools. A
  backend states only its shell: its commands, its network, and its
  isolation.
- **One set of environment helpers.** `BashEnv` holds rules that every
  `ExecutionEnv` needs. They move to the neutral layer, and the
  conformance entry checks them once:
  - the `~` and relative path rule (`bash-env.ts:105`)
  - the deadline that tells an abort from a timeout (`bash-env.ts:318`)
  - the bounded output view and its spill file (`bash-env.ts:303`,
    `bash-env.ts:284`)
  - the temporary names under `/tmp` (`bash-env.ts:217`)
- **One command for the default tools.** The `sql` export counts its rows
  with `xan` (`sql.ts:257`), which reads RFC 4180 quoting. The tool reads
  the export once and scans it: a newline outside quotes ends a record,
  and a newline inside quotes stays in the value. The same scan takes the
  preview records, so a quoted newline no longer splits a preview row
  (`sql.ts:188`). A backend then needs `sqlite3` alone. The scan holds one
  export in memory.
- **One layout.** The backend names the folders of the shared records:
  the audit log, the shared database, and the room mirrors
  (`audit.ts:21`, `sql.ts:35`, `mirror.ts:30`). The just-bash backends
  keep `/workspace` and `/rooms`, so no file moves.
- **One host identity.** The mirror runs as an agent that `openWorkspace`
  builds (`workspace.ts:77`). The workspace names it, so a backend with
  real accounts can give it credentials.

Each entry holds one thing:

- **A root entry that loads no backend.** `memoryBackend` and
  `directoryBackend` move to `@ambionframework/workspace/just-bash`, and a
  Biome rule keeps just-bash out of the neutral files. No package bundles
  the workspace for workerd, so `directoryBackend` imports `ReadWriteFs`
  statically, and the lazy import (`just-bash.ts:247`) goes.
- **One entry for each binding.** The root re-exports `./resource`
  (`index.ts:46`) and `./sql` (`index.ts:55`). Each binding keeps its own
  entry only.
- **The workbench follows the entries.** It imports the root today for
  every name below:
  - `directoryBackend` (`rooms.ts:18`) and `memoryBackend` (three tests)
    move to `./just-bash`
  - `openSqlResource` (`rooms.ts:19` and four tests) moves to `./sql`
  - the `SqlResource`, `SqlProvenance`, and `SqlResourceEnv` types
    (`definitions.ts`, `instrument.ts`, `approvals.ts`) move to `./sql`
- **No internal constants at the root.** `ROOM_MIRROR_GUIDANCE`,
  `roomMirrorPath`, and `DEFAULT_ROTATE_BYTES` (`index.ts:37`,
  `index.ts:39`) have no consumer. `roomMirrorPath` also fixes the
  `/rooms` path that the layout now names.

**M7 removes exports from a published package.** The note at the top of
this page applies: M7 adds no re-export, no deprecated alias, and no
compatibility test.

- `destroy()` leaves the three types that hold it.
- The change log exports go: `openChangeLog`, `DEFAULT_CHANGE_LOG`,
  `ChangeLog`, `ChangeLogOptions`, `ChangeQuery`, `WorkspaceChange`, the
  `changes` option, and `changedPaths`.
- `WorkspaceAgent` loses `identity`.
- The root stops exporting the backends, the resource contract, the SQL
  resource, and the three constants.

The changelog names each one. `workspace.md` and `resources.md` lose
their text on destruction and on the change log.

A new backend then implements `connect()` and an `ExecutionEnv` over the
shared helpers, names its layout, and passes the suite. It repeats no rule
of the neutral layer, and it loads no just-bash.

### R. Release

**R1. A repeatable release.** The 0.1.0 release ran from one machine with
a passkey and a token, and `DEV_BASE` in `dev-release.yml` is a literal. A
trusted workflow with `id-token: write` publishes with provenance and
needs no token on a laptop. The dev stamp reads its base from the last
tag. The changelog entry is the last gate before the tag.
