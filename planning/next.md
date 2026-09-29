# Next: the scope for 0.4.0

> **No compatibility promise before 1.0.0.** 0.3.0 shipped on 2026-09-25
> from commit 2eb30a3, with eleven packages on npmjs. Until 1.0.0, any
> release may change any export, entry point, journal body, stored format,
> or package API.
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

This file holds the open work for 0.4.0: the scope, the order of the work,
the evidence each step needs, and the reason for each item. What landed
leaves the phases, and the [changelog](../CHANGELOG.md) records it.
[backlog.md](backlog.md) holds everything after 0.4.0.

**An item lands with its evidence or stays open.** Every checkbox names an
item in [the items](#the-items). A phase closes when its evidence line
holds on main.

## Positioning

**Ambion is a collaboration kernel for agents and humans.** The
[README](../README.md) holds the statement, and
[Technical facts](../docs/technical-facts.md) holds the key facts and what
is new. Ambion is reactive: a seat acts when a person speaks, when a seat
addresses it, when the host posts, or when a say that it scheduled comes
due.

**0.4.0 is a release of simplification.** It adds four capabilities, the
`import` of the `sql` tool, the fixed skills of each agent, the
refs to workspace files and commits, and the post of the host, which the
changelog names. It removes each
second path to a fact of the room. Every item in the
[backlog](backlog.md) waits until after 0.4.0, unless its condition holds
first.

## The scope

**The journal holds five facts, and one fold reads them.** The facts are
messages, lease changes, closes, cancellations, and compositions. One pure
`decide` admits one entry for each command inside the journal queue, and
the reconcile runs `decide` until nothing changes. A review of the code
found a second path beside most of these mechanisms. Each second path
needs a consistency test, a conformance case, or a doc paragraph to hold
it to the first, and some copies had already drifted:

- The three classifiers of a permanent failure disagree on the API key,
  the login, and the quota.

**Acceptance.** Each fact of the room has one derivation, each rule one
home, and each seat one boundary. `pnpm check` passes, the coverage of
each changed package holds, and the changelog states the measured count
of lines that the release removes.

**Journal bodies.** A cancel entry carries no close, and the room
derives a cancelled close from it (C3). A composition carries no
`version` (C9). The body schemas refuse the old shapes, and the journal
carries no format number (C12). Ambion supports no downgrade.

**The `assistant` room option stays.** It is shorthand for `agents`,
`summary`, and `broadcast` attention. The owner keeps it for now.

**These pairs stay.**

- **`pi()` and `piExecution()`.** The first is definition data that
  crosses the wire. The second holds host functions and paths.
- **The two stop mechanisms of a process.** A process of this run stops
  by an abort, since just-bash has no pid. An adopted process stops by its
  pid.
- **The step mapping of each harness.** Each harness has its own wire
  format.
- **The view interfaces of the room host.** `RoomBase`, `ControlHost`,
  `DispatchHost`, `PeopleHost`, and `WaitsHost` keep `control.ts`,
  `dispatch.ts`, `people.ts`, and `waits.ts` below `room-host/room.ts` in
  the layers that Biome holds.

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

- **The checkpoint entry.** A measured resume time decides it.
- **The billing annotation (L3).** It carries over from 0.2.0 with its
  condition.
- **A repeatable release from CI (R1).** The owner runs the release.
- **The `python3` abort on Node 26.9 (K1).** It waits for a report or a
  failed gate.
- **A generated API reference.** It adds a build step and a CI check, and
  the typed README examples already hold the surface.
- **The open proofs.** The stop-loop and pass measures, unique roster
  names, `seatLive`, and `storedIdAccepted` remove no defect today.
- **A backend profile and concurrent operations.** A profile that lets the
  workspace owner run two agents at once changes the owner, so it waits
  for a measured need.
- **A SQL backend over a database server.** The workstation uses
  `sqliteBackend` on the Ambion host.
- **An `apply_patch` tool for Codex seats.** A live comparison with the
  `edit` tool decides it.
- **A publish flow for snapshots, and more forms of the `ambion` scheme.**
  Snapshot refs and commit refs land in 0.4.0. A publish to a store outside
  the workspace, the sweep of copies that no message cites, and the forms
  for a process output and a query wait for an application that needs
  them.

## Decisions taken

- **A process wakes no seat.** The agent waits for its result inside the
  activation, and a wait stops before the room ends the activation. A host
  that wants a wake calls `room.post`
  ([Processes](../docs/processes.md#the-end-of-a-process)).
- **A scheduled say goes to its author alone.** The `schedule` tool sets
  `to` to the author and `after` to its argument. On the record, `to` names
  the author if and only if `after` is set. The room stamps everything
  else: the author and the returned say. No seat speaks under the name of
  a person, and no seat schedules work for another seat.
- **The system speaks, and an exchange has no owner.** The host and the
  room's clock write a `posted` entry with no author, and a returned say
  is a post with `returns`. A post opens an exchange when none is open.
  Otherwise it joins the open exchange and steers its target, or each seat
  at work when it has no target. An exchange has an opening message and a
  `person`, the first person who spoke in its range.
  [Exchange](../docs/exchange.md#4-who-directs-one-and-who-receives-its-result)
  holds the rules.
- **The journal records the schedule, and the host arms the clock.** The
  fold holds the pending says, and the room's alarm takes the earliest due
  time beside the lease expiries and the retry times. A restart reads the
  pending says from the journal.
- **One example.** The agentic lab workspace in
  [docs/example.md](../docs/example.md) stays the one example.
- **Two entries.** `@ambionframework/ambion` for applications and
  `@ambionframework/ambion/hosting` for hosts and adapters.
- **The kernel imports no model library.** The Pi, Claude, and Codex
  executors are packages, and each one adapts a harness.
- **Speech enters the record through `say` only**, on every executor.
- **Two release channels.** CI publishes a dev build of `main` to GitHub
  Packages under `dev`. An official release goes to npmjs from the
  owner's machine.
- **One package for each deployment shape.** `@ambionframework/just-bash`
  holds the local pair, and `@ambionframework/workstation` holds the lab
  pair. The core names a git transport and holds the refusal. Each access
  type lives with its pair.
- **The git backend on the workstation takes the defaults of its
  design.** [Workstation git](../docs/workstation-git.md#decisions-taken)
  lists them: a key file in the agent's home, a second authorized-keys
  file, the template helpers in `@ambionframework/workspace/git`, the git
  account on the loopback address, and the transport names `in-process`
  and `ssh`.
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

**Three phases.** Phase 1 changes no extension contract. Phase 2 changes
the hosting exports, the executor contract, an option of `defineAgent`,
and the process tools. A step names the steps it needs; a step with no
"Needs" line starts now.

### Phase 1. The drift

- [ ] **8.** The assistant works a request after the person who asked leaves. (A1)

**Evidence:** each step keeps `pnpm check` green and holds the coverage
of each changed package, measured before and after as `CLAUDE.md`
states. A step that changes a rule runs `pnpm rule:check`. A step that
changes a journal body updates the golden journals and the export
snapshot in the same commit, and the changelog names it.

### Phase 2. The contracts

Each step states the change to
[Executors](../docs/executors.md#the-hosting-entry-exports) or to the
page it changes in the same commit.

- [ ] **5.** The core owns the activation state. (C6)
- [ ] **7.** Cloudflare reuses the core, and one scripted room serves the
      conformance suites. (C9)
- [ ] **8.** A live file on each harness uses `wait` on `handles`. (C10)

**Evidence:** the evidence of phase 1 holds for each step. Step 7 passes
`portConformance` on `rpcExecution` in workerd. Steps 5 and 8 pass one
live file on each of Pi, Claude, and Codex before they merge.

### Phase 3. Release

- [ ] **1.** The changelog entry for 0.4.0 names each export and each
      journal body that changed, and the count of lines removed. Needs
      phases 1 and 2.
- [ ] **2.** The live run on `main` after the last merge passes for Pi,
      Claude, and Codex. Needs 1.

## The items

**Each item removes one kind of second path.** Each states the problem,
the change, and the evidence.

**C6. The core owns the activation state.** Each of the Pi, Claude, and
Codex executors re-implements the `readThrough` and `cancelled` state,
the refresh test, the binding of the room tools, the `error` event, the
freshness of a steer, and the assembly of a prompt. The runner emits the
`error` event again. The core already causes or observes each of these
facts, and no executor calls `room.view` or `room.lease`.

- **A pass receives what the core decides.** The core hands a pass its
  rendered prompt, its room tools, its resume token, its abort signal,
  and its trace. The executor calls `read(range)` when the model consumes
  a range and `delivered(call)` when a tool result reaches the model.
- **The executor hosts the tools.** Pi runs them in its harness, Claude
  in an MCP server in the process, and Codex in the stdio server of
  `room-tools-server.ts`. The contract hands over tool values, and each
  executor hosts them in or out of its process.
- **Freshness moves into the core with no Pi type.** `pi/src/freshness.ts`
  holds the algorithm, and the core imports no model library. Claude's
  echo check is a weaker copy of it.
- **The core derives the tool events from the steps.** The pairing of
  call ids is copied in `claude-trace.ts` and `codex-trace.ts`. One rule
  sets which room tools raise no tool event. Today Codex also exempts
  `seat` and `unseat`.
- **One classifier names a permanent failure.** The three copies of
  `PERMANENT_TEXT` disagree on the API key, the login, and the quota.
- **An executor keeps its harness alone:** the step mapping, the resume,
  how it hosts the tools, and the signal that the model consumed input.

A third-party adapter builds on this contract, and the changelog names
each member that changes. **Evidence:** [Executors](../docs/executors.md)
states the new `pass` contract, `executorConformance` tests it on the
three executors, the prompt snapshot holds, and one live file passes on
each harness.

**C9. The host keeps one mechanism for each concern.**

- **Cloudflare reuses the core.** `recoveryCall` and `releaseRecovered`
  repeat the call of the runner, `RoomObject.visits` repeats the visits
  of the room, and `reconcileRoom` repeats `Room.reconcile()`.
- **One scripted room serves the conformance suites.** `scriptedRoom` and
  `executorRoom` merge, and the port suite keeps the cases that a port
  adds. `conformance.ts` and `conformance-executor-room.ts` each
  hold their own question, participants block, and `stale` constant; the
  merged room holds one of each, and `until` accepts an async predicate.
  This sub-item closes M5 of 0.2.0.

**Evidence:** the coverage of the core holds, and the Cloudflare tests
pass in workerd.

**C10. `wait` takes `handles` alone.** The owner keeps `status`, `ps`,
and `wait` as three tools: each answers one question. The change landed
in #354: `wait` takes `{ handles, timeout? }`, with 1 to 16 handles, and
one handle gives the result of `status`. The evidence is open. No live
file of `packages/ambion` starts a process, so the harness jobs do not
exercise `wait`. **Evidence:** one live file on each harness that shows
no loss in the use of a process.

**The code of C10 landed, and the live file passes on Pi and Codex.** The
live file is `packages/workspace/test/live/workspace.test.ts`, which runs
on Pi, Claude, and Codex through `AMBION_HARNESS`. On 2026-09-29 its case
"waits for them with wait" passed on Pi with `openai/gpt-5.6-luna` and on
Codex: each model made two `wait` calls with `handles`, and the harness
refused none. The Claude run waits for the live run on `main`, and the
step closes when it passes.

**A1. The assistant works a request after the person who asked leaves.** This item
fixes a defect and adds no capability. A room stays available between
interactions, so a person who asks and leaves gets the answer later.

- **The problem.** On 2026-09-25, a Workbench test sent `/try` in the four
  sample rooms and switched rooms at once. Each switch wrote `left` for the
  person two seqs after the question. In `bringup` and `power`, the
  assistant released its activation with no say and no seat. Its closing
  summary read "this exchange closed with no answer … you left before the
  datasheets and design specialists could be engaged". In `sensing`, the
  same `left` came, and the assistant routed the work. The same question,
  sent with the person present, got a full answer in both rooms. The
  guidance of `packages/assistant` says nothing about presence, so the
  model decides.
- **The change.** The membership guidance states that the presence of the
  person who asked does not change the work. The assistant seats and routes
  as it does for a person who stays, and the closing summary goes to the
  `person` of the exchange.
- **Seen in the same run, not in scope.** In `firmware`, the assistant
  forked, edited, and pushed the work itself and sent nothing to a
  specialist, while [Default assistant](../docs/assistant.md) keeps it to
  membership and summaries. The Workbench gives every seat the same tools.
  In `power`, `design` said "Working the sum + margin now … one moment."
  before its answer, and its instructions forbid an acknowledgment.

**Evidence:** a case in `packages/assistant/test/live/behavior.test.ts`,
at pass^3, where the person asks and leaves before the first activation.
The assistant sends a directed request to a specialist, and the closing
summary answers the question. The live suite of the assistant stays green.
