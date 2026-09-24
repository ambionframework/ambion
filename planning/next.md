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

This file holds the open work for 0.2.0: the scope, the order of the work,
the evidence each step needs, and the reason for each item. What landed
leaves this file, and the [changelog](../CHANGELOG.md) records it.
[backlog.md](backlog.md) holds everything after 0.2.0, and its first
section holds the scope for 0.3.0.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, and
[Technical facts](../docs/technical-facts.md) holds the key facts and what
is new. 0.1.0 makes a room a place that agents and people use when a
person asks a question. 0.2.0 makes the kernel cheaper to change, and it
gives each agent a workspace on a real server, where the operating system
keeps one agent's files apart from another's. 0.3.0 makes a room useful
between questions ([backlog](backlog.md#030-the-room-works-between-questions)).

## The scope

**Five items already landed on main.** The changelog names the export
changes of each one.

| Item                                                | PR         | What it gives 0.2.0                                                                                                                                        |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7. The workspace as an interface                   | #276, #277 | A neutral root entry, a conformance entry, one entry for each binding, and backends by kind: bash and an optional SQL                                      |
| S1. The workstation, `@ambionframework/workstation` | #280       | A bash backend over SSH with one Unix account for each agent, tested on an in-process server and on OpenSSH                                                |
| The removal of `@ambionframework/cli`               | #273       | Every library package needs only Node `>=22.19.0`                                                                                                          |
| M1. Kernel decision layers                          | #286       | `evolve` in test support, one said-content matcher, one summary narrowing, one landed-message base, and the summary text in `render.ts`                    |
| M2. The rules sweep                                 | #291       | Every exported room rule but `exchangeOutcome` gates a write, and `draftsClose` counts a summary draft by the writer's seat in the fold and in the verdict |

**Two themes stay open, each with the acceptance it must meet on the
tagged commit.** The phases below deliver them; the items explain them.

| Theme                     | Acceptance                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M One owner per mechanism | Each duplication that items M3 to M6 name has one owner. The rules file carries only rules that gate a write, and `exchangeOutcome` until W2. The journal package owns the one crash-safe append loop. Each doc fact has one home. |
| R A repeatable release    | A trusted CI workflow publishes the release to npmjs with provenance. The dev build stamp follows the next release.                                                                                                                |

**The tag waits for the P0 and P1 steps.** A P2 step that is open when the
last P1 step closes moves to the backlog. It does not hold the tag.

**Format changes.** The changelog names each change to a stored format.

| Change                                                    | Item | Kind                        |
| --------------------------------------------------------- | ---- | --------------------------- |
| `pi-journal` and the Pi transcript audit are gone         | —    | A stored namespace retires  |
| The `session` on an ended lease names an exchange session | —    | A stored field that changes |

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

- **The wake sources and the delegation.** The notice (W1), the timer
  (W2), and delegation by reference (D1) are the scope of 0.3.0.
  [Decisions taken](#decisions-taken) states the reason.
- **The checkpoint entry.** The W2 resume measurement decides it.
- **A generated API reference.** It adds a build step and a CI check, and
  the typed README examples already hold the surface.
- **The evals package.** PR #153 is a draft, conflicts with main, and
  carries its own list of open work.
- **The open proofs.** The stop-loop and pass measures, unique roster
  names, `seatLive`, and `storedIdAccepted` remove no defect today.
- **A backend profile and concurrent operations.** The workstation ships
  with the one queue that the workspace owner keeps for every agent
  (`resource.ts:80`). A profile that lets the owner run two agents at once
  changes the owner, so it waits for a measured need.
- **A SQL backend over a database server.** The workstation uses
  `sqliteBackend` on the Ambion host.

## Decisions taken

- **0.2.0 carries no wake source and no delegation.** Phase 1 changes the
  files that W1, W2, and D1 change. A tag between the two lets 0.3.0 start
  on a stable kernel, and 0.2.0 keeps one format change.
- **`exchangeOutcome` stays a verified rule until W2.** The M2 sweep
  classifies every other exported rule. The `awaiting` expiry decides this
  one.
- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages.
- **Speech enters the record through `say` only**, on every executor.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs.
- **Two public names stay.** `RoomObject.exchange` saves the snapshot
  payload over the Durable Object RPC boundary. `speakOnce` is the minimal
  reference that a transport author needs. A removal of either adds rules
  for callers, so neither is in the release.

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

**Two lanes run at once, and the release closes them.** A step names the
steps it needs; a step with no "Needs" line starts now. **P0** blocks the
tag. **P1** carries the release story. **P2** moves to the backlog when it
is late.

| Lane | Chain                                     | Priority   |
| ---- | ----------------------------------------- | ---------- |
| A    | Phase 1: the kernel                       | P0         |
| B    | Phase 2: the packages                     | P0, P1, P2 |
| —    | Phase 3: the release, after lanes A and B | P1         |

**The two lanes edit different files.** Phase 1 edits the room files and
the docs. Phase 2 edits the journal, adapter, workspace log,
and conformance files.

### Phase 1. Consolidate the kernel (P0)

**Goal:** each doc fact has one home. M1 and M2 landed the kernel half:
each kernel rule has one owner, and every rule in the rules file but
`exchangeOutcome` gates a write ([formal.md §8](../docs/formal.md#8-why-each-room-rule-is-a-rule)).

- [ ] **1.** Each doc fact has one home. (M6)

**Evidence:** `pnpm check`; each fact in the M6 table appears on its home
page only.

### Phase 2. Package hygiene (P0, P1, and P2)

**Goal:** the journal, adapter, workspace, and conformance
code keep one copy of each mechanism.

- [ ] **1.** One crash-safe append loop in `packages/journal`. P0. (M3)
- [ ] **2.** The workspace logs: carry PR #171 onto main and land it,
      then one record path, one file match, one table, and one call
      envelope. P1. (M4)
- [ ] **3.** One set of scripted room fixtures in the conformance suite.
      P2. (M5)

**Evidence:** `pnpm check`; `pnpm chaos` and the restart suite for step 1.

### Phase 3. Release (P1)

**Goal:** the release repeats without the owner's machine.

- [ ] **1.** The changelog entry for 0.2.0: the format changes, each
      export that changed or went, and the workstation package. Needs
      phase 1 and phase 2 steps 1 and 2. (R1)
- [ ] **2.** The dev build stamp derives its base from the last tag.
      (R1)
- [ ] **3.** An npmjs release that a trusted CI workflow runs with
      provenance. Needs 2. (R1)

**Evidence:** a release from CI installs without a token; the dev stamp
after the 0.2.0 tag sorts above 0.2.0.

## The items

Each item states the problem, the solution, and the impact. The file and
line references are from `main` at `d86e803`.

### M. One owner per mechanism

**M3. One crash-safe append loop.** The `Journal` class and
`MetadataJournal` (`cloudflare/src/storage.ts`) each write a serial queue,
a cursor replay, and an in-doubt recovery by hand. The third copy went with
`pi-journal`.

- Extract one append primitive in `packages/journal` with an `apply` and a
  `recover` callback. Rebuild `MetadataJournal` on it, and keep every
  stored record byte-identical.
- Replace `positionRead` (`journal/src/storage.ts:52`) with the verified
  `scanned` rule at its two callers.
- Retire the random mutation `id` and the `mutations` map of
  `MetadataJournal`. The caller's `source.id` answers the in-doubt
  question.
- Make `envelope` (`journal/src/journal.ts:198`) throw for a known kind
  with a malformed seq. A skip hides corruption.

**M4. The workspace logs.** PR #171 fixes a regression: when a directory
failure clears on retry, the audit log writes the entry as an oversized
entry. The fix is not on main. PR #171 branches from a history that main
no longer shares, so its one commit goes onto main as a new change. Land
it before the rest, because the rest edits the same code.

- One best-effort record path and one `reportError` in
  `workspace/src/log.ts`, for the workspace audit log (`audit.ts:133`) and
  `mirror.ts:136`.
- One rotated-file match beside `rotatedName` (`log.ts:45`), for
  `isLogFile` (`mirror.ts:100`).
- One import-free Markdown table module for `sql-tool.ts:160` and
  `sql-resource.ts:267`.
- One private `callEnvelope` for the two copies of the provenance prefix
  (`tools.ts:50`, `sql-resource.ts:211`).

**M5. The conformance suite.** `conformance.ts` and
`conformance-executor-room.ts` each hold their own question, participants
block, and `stale` constant (`conformance.ts:177`,
`conformance-executor-room.ts:88`).

- The shared question, participants block, and `stale` constant move to
  `conformance-support.ts`. `until` accepts an async predicate.

**M6. Each doc fact has one home.** The positioning rule in
[CLAUDE.md](../CLAUDE.md) states that every page states a fact once.

| Fact                                   | Home                 | Where it repeats                    |
| -------------------------------------- | -------------------- | ----------------------------------- |
| The legacy-refusal and resume rule     | `room.md`            | `summary.md:144`, `roster.md:100`   |
| The table of the two spans             | `room.md`            | `exchange.md:14`                    |
| The list of what is new                | `technical-facts.md` | The claim at `technical-facts.md:3` |
| The assistant seats normalization      | `assistant.md`       | `roster.md:35`                      |
| The tool-call provenance subset        | `resources.md`       | `agent.md:86`, `workspace.md:119`   |
| The owner rules and two test citations | The owning pages     | `patterns.md:33`, `patterns.md:45`  |

The README keeps the headline of what is new. `technical-facts.md` keeps
the list.

### R. Release

**R1. A repeatable release.** The 0.1.0 release ran from one machine with
a passkey and a token, and `DEV_BASE` in `dev-release.yml` is a literal. A
trusted workflow with `id-token: write` publishes with provenance and
needs no token on a laptop. The dev stamp reads its base from the last
tag. The changelog entry is the last gate before the tag.
