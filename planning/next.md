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
leaves the phases, and the [changelog](../CHANGELOG.md) records it.
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
keeps one agent's files apart from another's. It also gives a workspace a
git backend: an agent forks a template, clones it, and pushes its work.
In 0.2.0 each executor adapts a harness, and a seat keeps its harness
session for one exchange.

**0.3.0 makes Ambion responsive to environment events.** Through 0.2.0,
Ambion is reactive: a seat acts when a person speaks, or when a seat
addresses it. An environment event is a change outside the room, such as
a push to a repository, a job that ends, or a timer that comes due. In
0.3.0, an environment event reaches the room as a notice, and the room
wakes the seats that attend to it. The notice (W1), the timer (W2), and
delegation by reference (D1) carry the change
([backlog](backlog.md#030-the-room-works-between-questions)).

## The scope

**Eleven changes already landed on main.** The changelog names the export
changes of each one. Items M1, M2, M7, S1, and S2 came from this plan. The
other rows landed as their own pull requests, and the plan records them
here so that the release names them.

| Change                                              | PR               | What it gives 0.2.0                                                                                                                                        |
| --------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M7. The workspace as an interface                   | #276, #277       | A neutral root entry, a conformance entry, one entry for each binding, and backends by kind: bash and an optional SQL                                      |
| S1. The workstation, `@ambionframework/workstation` | #280, #283, #284 | A bash backend over SSH with one Unix account for each agent, tested on an in-process server and on OpenSSH                                                |
| S2. The git backend, `@ambionframework/git`         | #299             | Read-only templates, forks, clones into the home, and pushes, on the just-bash backends and the workstation, tested on a real `git` and on OpenSSH         |
| The removal of `@ambionframework/cli`               | #273             | Every library package needs only Node `>=22.19.0`                                                                                                          |
| M1. Kernel decision layers                          | #286             | `evolve` in test support, one said-content matcher, one summary narrowing, one landed-message base, and the summary text in `render.ts`                    |
| M2. The rules sweep                                 | #291             | Every exported room rule but `exchangeOutcome` gates a write, and `draftsClose` counts a summary draft by the writer's seat in the fold and in the verdict |
| The room tools in the hosting entry                 | #287             | `roomTools` and `agentTools` hold the room tool rules once. The Pi, Claude, and Codex executors adapt them and keep no copy                                |
| `@ambionframework/just-bash`                        | #288, #289       | The workspace installs no just-bash, and the workstation installs 72 fewer packages. Each just-bash shell runs `git`, locked to the agent                  |
| Package hygiene reads the built files               | #285             | `check:packages` fails on an undeclared import in `dist` and on bundled code from outside the package's own `src`                                          |
| Exchange continuity, and the trace as host logs     | #294             | A seat keeps its harness session for one exchange. `@ambionframework/pi-journal` and the trace journals go, and each step goes to the host's logger        |
| The Pi executor on Pi's AgentHarness                | #295             | The harness owns the model loop, the session, and compaction. Pi joins Claude and Codex as a harness adapter, and it runs the executor conformance suite   |

**Three themes stay open, each with the acceptance it must meet on the
tagged commit.** The phases below deliver them; the items explain them.

| Theme                     | Acceptance                                                                                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M One owner per mechanism | Each duplication that items M3 to M6 name has one owner. The rules file carries only rules that gate a write, and `exchangeOutcome` until W2. The journal package owns the one crash-safe append loop. Each doc fact has one home. |
| L Live evidence           | The live tier passes on the release candidate for the Pi, Claude, and Codex harnesses.                                                                                                                                             |
| R A repeatable release    | A trusted CI workflow publishes the release to npmjs with provenance. The dev build stamp follows the next release. The pages that name a release name 0.2.0.                                                                      |

**The tag waits for the P0 and P1 steps.** A P2 step that is open when the
last P1 step closes moves to the backlog. It does not hold the tag.

**Format changes.** The changelog names each change to a stored format.

| Change                                                                                | Item | Kind                        |
| ------------------------------------------------------------------------------------- | ---- | --------------------------- |
| The `ambion/pi-session` journals and the Pi transcript audit are gone                 | —    | A stored namespace retires  |
| The `ambion/trace` journals are gone                                                  | —    | A stored namespace retires  |
| The `session` on an ended lease names an exchange session, and a failed lease has one | —    | A stored field that changes |

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
  (W2), and delegation by reference (D1) make Ambion responsive to
  environment events in 0.3.0.
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
- **An `apply_patch` tool for Codex seats.** A live comparison with the
  `edit` tool decides it.

## Decisions taken

- **0.2.0 stays reactive.** It carries no wake source and no delegation.
  Phase 1 changes the files that W1, W2, and D1 change. A tag between the two lets 0.3.0 start
  on a stable kernel. The 0.2.0 format changes retire two namespaces and
  change one field, and add no entry kind.
- **`exchangeOutcome` stays a verified rule until W2.** The M2 sweep
  classifies every other exported rule. The `awaiting` expiry decides this
  one.
- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages, and each one adapts a harness.
- **Speech enters the record through `say` only**, on every executor.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs.
- **Two public names stay.** `RoomObject.exchange` saves the snapshot
  payload over the Durable Object RPC boundary. `speakOnce` is the minimal
  reference that a transport author needs. A removal of either adds rules
  for callers, so neither is in the release.
- **The live tier stays off pull requests.** A step that changes a
  harness path proves it with one live file on that harness before it
  merges. The CI run on `main` confirms it.

## The model to preserve

| Concern                                                       | Owner                 | Rule                                                                                                  |
| ------------------------------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| Definitions, executors, tools                                 | Application code      | Fixed per room run; no executable code in the journal                                                 |
| Membership, presence, messages, exchanges, claims, references | Room journal          | Pure interpretation of confirmed entries                                                              |
| Model loops, harness sessions, activation steps               | Executor              | One harness session for each seat in each exchange, a cache; steps to the trace; speech through `say` |
| Files, tables, instruments, and their change logs             | Application resources | Independent of journal transactions; stamped with provenance                                          |
| Timers, runners, subscriptions, live handles, trace logs      | Host                  | Armed again from the journal after restart; the trace logger changes no outcome                       |
| Identity selection, discovery, hosting state, delivery outbox | Application           | Explicit entry and stable retry keys                                                                  |

**Judge a change by the obligation it removes.** Fewer exports are useful
when callers need fewer rules. A rename earns its place only when one name
means two things or two names mean one.

## The order of work

**Three lanes run at once, and the release closes them.** A step names the
steps it needs; a step with no "Needs" line starts now. **P0** blocks the
tag. **P1** carries the release story. **P2** moves to the backlog when it
is late.

| Lane | Chain                                         | Priority   |
| ---- | --------------------------------------------- | ---------- |
| A    | Phase 1: the kernel                           | P0         |
| B    | Phase 2: the packages                         | P0, P1, P2 |
| C    | Phase 3: live evidence                        | P1, P2     |
| —    | Phase 4: the release, after lanes A, B, and C | P1         |

**The lanes edit different files.** Phase 1 edits the docs. Phase 2 edits
the journal, adapter, workspace log, and conformance files. Phase 3 edits
the live tests and the live workflow.

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

### Phase 3. Live evidence (P1 and P2)

**Goal:** the tag carries live evidence for each harness that 0.2.0
changed.

- [ ] **1.** The Codex harness runs the live tier. P1. (L2)
- [ ] **2.** A provider billing or authentication failure reads as that
      failure in the live run. P2. (L3)
- [ ] **3.** The live tier passes on the release candidate for Pi,
      Claude, and Codex. P1. Needs 1. (L2)

**Evidence:** the run of the live workflow on the release candidate, with
each harness job green and no job skipped.

### Phase 4. Release (P1)

**Goal:** the release repeats without the owner's machine.

- [ ] **1.** The changelog entry for 0.2.0: the format changes, each
      export that changed or went, the three new packages, and the two
      retired packages. Needs 2. Needs phase 1, phase 2 steps 1 and 2,
      and phase 3 step 3. (R1)
- [ ] **2.** The pages that name a release name 0.2.0 and list its eleven
      packages. (R2)
- [ ] **3.** The dev build stamp derives its base from the last tag.
      (R1)
- [ ] **4.** An npmjs release that a trusted CI workflow runs with
      provenance. The retired packages carry an npm deprecation. Needs 3.
      (R1)

**Evidence:** a release from CI installs without a token; the dev stamp
after the 0.2.0 tag sorts above 0.2.0; `npm view` shows the deprecation on
`@ambionframework/cli` and `@ambionframework/pi-journal`.

## The items

Each item states the problem, the solution, and the impact. The file and
line references are from `main` at `67ecb72`.

### M. One owner per mechanism

**M3. One crash-safe append loop.** The `Journal` class and
`MetadataJournal` (`cloudflare/src/storage.ts:46`) each write a serial
queue, a cursor replay, and an in-doubt recovery by hand. The third copy
went with `pi-journal`.

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
- One import-free Markdown table module for `sql-tool.ts:161` and
  `sql-resource.ts:268`.
- One private `callEnvelope` for the two copies of the provenance prefix
  (`tools.ts:43`, `sql-resource.ts:208`).

**M5. The conformance suite.** `conformance.ts` and
`conformance-executor-room.ts` each hold their own question, participants
block, and `stale` constant (`conformance.ts:177`,
`conformance-executor-room.ts:91`). Since #295, all three executors run
the executor suite, so a fixture change reaches three packages.

- The shared question, participants block, and `stale` constant move to
  `conformance-support.ts`. `until` accepts an async predicate.

**M6. Each doc fact has one home.** The positioning rule in
[CLAUDE.md](../CLAUDE.md) states that every page states a fact once.

| Fact                                        | Home                                | Where it repeats                    |
| ------------------------------------------- | ----------------------------------- | ----------------------------------- |
| The legacy-refusal and resume rule          | `room.md`                           | `summary.md:144`, `roster.md:100`   |
| The table of the two spans                  | `room.md`                           | `exchange.md:18`                    |
| The list of what is new                     | `technical-facts.md`                | The claim at `technical-facts.md:3` |
| The assistant seats normalization           | `assistant.md`                      | `roster.md:35`                      |
| The tool-call provenance subset             | `resources.md`                      | `agent.md:86`, `workspace.md:120`   |
| The owner rules and two test citations      | The owning pages                    | `patterns.md:32`, `patterns.md:45`  |
| Exchange continuity and where sessions live | `executors.md` §Exchange continuity | `README.md:135`, `trust.md:83`      |

The README keeps the headline of what is new. `technical-facts.md` keeps
the list. For exchange continuity, the README keeps one sentence and a
link. `trust.md` keeps the trust fact and links the rule. Each executor
page and package README states only where its own harness keeps a session.

### L. Live evidence

**The live tier gave no signal from 2026-09-22 to 2026-09-24.** Runs 340
to 363 of the live workflow failed on the Anthropic message "Your credit
balance is too low", except run 352, which was cancelled. Every change from #271 to #294 merged with no live
run in CI. Run 364, on `67ecb72`, is the first run with credit: Pi and the
package tiers pass, Claude fails one case, and Codex skips. The changelog
records the fix of the Claude case: a resumed Claude session kept the
system prompt it began with, so a closing activation lost its duties. It
also records a second Claude fix that a local run found: a seat no
longer takes the session id of a host that runs inside Claude Code.
Items L1 and L4 held those two fixes, so they left this file.

**L2. The Codex harness has no live run in CI.** Until 2026-09-24 the
`CODEX_API_KEY` repository secret was empty, so the Codex harness job and
the Codex package tier skipped on every run. The room tools of #287 and
the thread resume of #294 reach Codex, and neither has a live run. The
owner added the secret. Run 365, the first with the key, passed the Codex
harness job and failed three Codex package tests. Each needs a native
command, and none ran. The Codex sandbox runs a command through bubblewrap,
which needs an unprivileged user namespace, and AppArmor on Ubuntu 24.04
restricts such namespaces by default. A seat with native tools now runs
with no Codex sandbox by default. The next run on `main` confirms the cause.
The item closes when a run on `main` passes both Codex jobs.

**L3. A billing failure reads as a billing failure.** Twenty-three red
runs in a row had one cause, and each run read as a set of test failures.
A red run that stays red carries no information about the code. Before the
tests, each harness job makes one small request. A billing or
authentication refusal fails the job with an annotation that names the
provider error, and the tests do not run.

### R. Release

**R1. A repeatable release.** The 0.1.0 release ran from one machine with
a passkey and a token, and `DEV_BASE` in `dev-release.yml:40` is a
literal. A trusted workflow with `id-token: write` publishes with
provenance and needs no token on a laptop. The dev stamp reads its base
from the last tag. The changelog entry is the last gate before the tag.

- npmjs holds a trusted publisher setting for each package. Check whether
  npmjs lets a package that is not yet on the registry take one. If not,
  `@ambionframework/just-bash`, `@ambionframework/workstation`, and
  `@ambionframework/git` need a first publish by the owner before the
  workflow runs.
- `@ambionframework/cli` and `@ambionframework/pi-journal` stay at 0.1.0
  on npmjs. `npm deprecate` gives each one a message. The `pi-journal`
  message names the host's trace logger. The CLI message states that the
  package has no replacement.
- The Unreleased section describes changes that later changes removed.
  The `pi-journal` peer dependency entry describes a package that the
  release does not ship. The entry for 0.2.0 states the end state once.

**R2. The pages that name a release.** Several pages still name 0.1.0 or
list its packages.

- The package table of `technical-facts.md:93` lists eight packages. It
  lacks `just-bash`, `workstation`, and `git`, and the workspace row names a
  directory workspace that moved to `just-bash`.
- `technical-facts.md:4`, `docs/README.md:17`, `example.md:3`,
  `deployment.md:281`, `deployment.md:303`, and `room.md:8` name 0.1.0.
- `docs/README.md` calls the workspace "the Pi filesystem binding". The
  workspace has been an interface since M7.
- `toolchain.md` §9 shows the 0.1.0 release sequence and states that no
  package carries provenance. R1 changes both.
