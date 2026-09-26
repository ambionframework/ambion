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
addresses it, or when a say that it scheduled comes due.

**0.4.0 is a release of simplification.** It adds one capability, the
`import` of the `sql` tool, which the changelog names. It removes each
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
- A seat of an unknown executor kind under `composeExecutions` gets its
  wake again after each resend window, with no end.
- `defineHuman` trims preferences, and `captureHuman` does not.

**Acceptance.** Each fact of the room has one derivation, each rule one
home, and each seat one boundary. `pnpm check` passes, the coverage of
each changed package holds, and the changelog states the measured count
of lines that the release removes.

**Journal bodies.** A close carries `cancelled`, a cancel entry carries
no close (C3), and a composition carries no `version` (C9). The body
schemas refuse the old shapes, and the journal carries no format number
(C12). Ambion supports no downgrade.

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

## Decisions taken

- **A process wakes no seat.** The agent waits for its result inside the
  activation, and a wait stops before the room ends the activation. A host
  that wants a wake posts a message
  ([Processes](../docs/processes.md#the-end-of-a-process)).
- **A scheduled say goes to its author alone.** `to` names the author if
  and only if `after` is set. The room stamps everything else: the author,
  the returned say, and the owner of the exchange that it opens.
  No seat speaks under the name of a person, and no seat schedules work
  for another seat.
- **A returned say is an ordinary message when it lands.** It opens an
  exchange when none is open. When an exchange is open, it joins it and
  steers work, and the owner of that exchange stays the owner.
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

- [ ] **3.** A cancellation has one shape. (C3)
- [ ] **4.** A seat of an unknown executor kind fails at once, on each
      of the three routers. (C5)
- [ ] **5.** A composition carries no `version`, one capture serves a
      definition, and one registry serves the waiters. (C9)
- [ ] **6.** One record for a live process in the table. (C11)
- [ ] **7.** The body schemas guard the journal, and the format number
      goes. Needs 3 and 5. (C12)
- [ ] **8.** The assistant works a request after its owner leaves. (A1)

**Evidence:** each step keeps `pnpm check` green and holds the coverage
of each changed package, measured before and after as `CLAUDE.md`
states. A step that changes a rule runs `pnpm rule:check`. A step that
changes a journal body updates the golden journals and the export
snapshot in the same commit, and the changelog names it. Steps 3, 5, and 7
pass `pnpm chaos` and the Cloudflare tests in workerd.

### Phase 2. The contracts

Each step states the change to
[Executors](../docs/executors.md#the-hosting-entry-exports) or to the
page it changes in the same commit.

- [ ] **1.** `decide` builds every journal body and makes every authority
      decision. Needs phase 1 step 3. (C4)
- [ ] **2.** One lease shape in the rules. Needs phase 1 step 3. (C2)
- [ ] **3.** The remote call is an `Execution`, and `Transport` goes.
      Needs phase 1 step 4. (C5)
- [ ] **4.** The room applies the token limit, and the paging of a view
      goes. (C7)
- [ ] **5.** The core owns the activation state. Needs 3 and 4. (C6)
- [ ] **6.** The workspace keeps one SQL path and the ports that a
      backend uses. (C8)
- [ ] **7.** Cloudflare reuses the core, and one scripted room serves the
      conformance suites. Needs 1 and 3. (C9)
- [ ] **8.** One tool for `status` and `wait`. (C10)

**Evidence:** the evidence of phase 1 holds for each step. Steps 3 and 7
pass `transportConformance` on `rpcTransport` in workerd. Steps 5 and 8
pass one live file on each of Pi, Claude, and Codex before they merge.

### Phase 3. Release

- [ ] **1.** The changelog entry for 0.4.0 names each export and each
      journal body that changed, and the count of lines removed. Needs
      phases 1 and 2.
- [ ] **2.** The live run on `main` after the last merge passes for Pi,
      Claude, and Codex. Needs 1.

## The items

**Each item removes one kind of second path.** Each states the problem,
the change, and the evidence.

**C2. One home for each rule.** A rule that the room decides by lives in
`rules.verified.ts`, and the caller runs its body. The rules still read
one lease in four shapes.

- **The rules read one lease shape.** They read a lease as `Hold`,
  `Taken`, `Draft`, and `LiveLease`, and `takenOf`, `draftsOf`, and
  `liveLeases` convert between them. One `RuleLease` replaces the four.
  This sub-item re-proves the rules that read them, and it follows the
  cancelled close of C3, which changes what `Hold` holds. Phase 2 step 2
  holds it.
- **The lease `since` takes its name in the same proof edit.**
  [Deferred by decision](backlog.md#deferred-by-decision) holds the name until a
  proof edit renames it, and this sub-item is that edit.

**Evidence:** `pnpm rule:check` on each changed rules file, and
`pnpm check:lemmascript`.

**C3. One shape for a cancellation.** A `cancel` entry can carry a
close. That close needs its own schema in `journal/validate.ts`, its own
branch in the fold and the projection, and the list
`RoomState.cancelClosed`, which exists only so that `exchangeOutcome` can
ask whether a cancellation wrote a close. The room also applies a
cancellation twice: at once through `cancelHold` and an empty wake list,
and later as a `survivesCancellation` filter in four places. In the
projection, the filter in `pendingOf` is always true.

- **A close carries `cancelled`.** The cancellation writes a close with
  `cancelled: true` into `closes`. `cancelClosed` and the second close
  schema go.
- **Each fact takes one mechanism.** Wakes and scheduled says drop at
  the cancellation. A grant keeps the filter, since it reads an id against
  the whole record.

**Evidence:** the `cancelled` golden journal and its `.fold.json` change
shape, `pnpm rule:check` on the room rules, `pnpm chaos` on both
storages, and the Cloudflare tests in workerd.

**C4. `decide` is the one decision point.** The reconcile in
`transition.ts` builds the bodies of returned says, closes, and lease
endings, and `control.ts` discards each body and submits a command that
decides again. `dueSays` and `returning` check the same condition, and so
do the close in `planReconciliation` and `admitsClose`. The seat protocol
in `answers.ts` checks liveness, the grant, and the roster that
`transition.ts` checks again. `validatePresence` runs the `decide` that
the commit runs again. `room.ts` repeats the name and summary checks of
`transition.compose`.

- **The reconcile emits commands.** `return`, `close`, and `end` go to
  `decide`, and `decide` alone builds a body.
- **A seat release is a command.** `answers.ts` maps a refusal to its
  answer, and one pure `seatAuthority` in `room/` serves `view`.
- **`seatAuthority` answers a missing grant in the `stale` category.**
  [Executors](../docs/executors.md) states that an adapter aborts on
  `stale` and continues on `refused`, so a seat whose grant is gone stops
  at once, as it does today.
- **One `decideAndAppend` serves the host.** It replaces about nine
  hand-written `submit(() => decide(...))` wrappers, and it takes the
  `gone()` guard as an option, since stop still writes revocations and
  departures. `end` takes one object in place of six positional
  arguments.

**Evidence:** the refusal tests and the history walk of
`consistency.test.ts` pass unchanged, and the Cloudflare tests pass in
workerd.

**C5. One boundary between the room and a seat.** Three routers pick an
execution by executor kind: `composeExecutions` and
`defaultExecutionFactory` in `host/runtime.ts`, and `missingConnector` in
`room.ts`. They fail in two ways. `composeExecutions` throws in
`connect`, `portFor` in `room-host/dispatch.ts` reports a
`delivery_error`, and the wake stays due, so the room sends it again after
each resend window with no end. `missingConnector` fails the activation
at once. `composeConnector` also builds the executor and hands it to the
`Transport`. Cloudflare's `rpcTransport` keeps only `room` and `seat`, and
the seat object builds the executor a second time in `configure.ts` and
`seat-object.ts`.

- **A kind with no execution fails its activation at once, on every
  router.** `composeExecutions` returns a port whose activation fails,
  as `missingConnector` does. This fix changes no contract, and phase 1
  holds it.
- **The remote call is an `Execution`.** Its connector returns a port
  over RPC, and the seat object calls the execution of its own host.
  `Transport`, `inProcessTransport`, and the transport options of the
  runtime and the hosting go. [Executors](../docs/executors.md) states
  the new hosting exports.
- **One router serves every kind.** `defineExecution(kind, build)`
  returns an `Execution` and registers the default for its kind.
- **Every execution keeps the host's trace limits.** Claude and Codex
  pass `DEFAULT_TRACE_LIMITS` today, and `ConnectorComposition` exists
  for that difference.

**Evidence:** a scripted case of an unknown kind under
`composeExecutions` that ends the activation, `transportConformance` on
`rpcTransport` in workerd, and the hosting export snapshot.

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

**C7. One windowing rule.** `room/view.ts` keeps the newest messages,
never splits a summarised range, and keeps the open exchange whole. The
runner applies the same rule by tokens in `windowedView` and
`windowToLimit`, and the `ViewRange` paging of `room.view` exists only
for it. On Cloudflare each page is an RPC round trip.

- **The room applies the token limit** inside the view, and the paging
  and the optional `range` of `RoomProtocol.view` go.
- **`estimateTokens` becomes a name.** A function does not cross the
  wire, so the room host holds a registry of named estimators. The
  executor options of `pi()`, `claude()`, and `codex()` take the name,
  and the Cloudflare room object reads the registry of its runtime.
- **The decision in [Definitions and tools](../docs/agent.md) changes.**
  It states that the seat runs `estimateTokens`. The item rewrites it,
  and [Pi](../docs/pi.md), [Claude](../docs/claude.md), and
  [Codex](../docs/codex.md) state the name.

**Evidence:** the window tests of the room and the runner merge, the
rendered record of each case stays the same, and the export snapshot
names the changed option.

**C8. The workspace keeps one SQL path and the ports that a backend
uses.**

- **One SQL path.** `sql-resource.ts`, the `./sql` export, opens
  `node:sqlite` beside `sqliteBackend`, with a second copy of the preview
  and the table render. The workbench and
  [Resources](../docs/resources.md) use it. Append-only and provenance
  become options of `sqliteBackend`, the workbench moves to them, and
  `sqlConformance` moves into the SQLite tests until a second SQL backend
  exists.
- **The spill file goes.** Only tests and conformance ask for
  `capture.spill`, since every `bash` call writes its output to a
  process file. One `runScript` helper replaces six copies of the
  collect-and-check code, and one shell quote replaces three.
- **`BashBackend.tools` goes.** No backend sets it.
- **`openWorkspace` alone checks a git transport.** The second check in
  `justGitAccess` and `sshAccess` goes. The G theme holds the
  `openWorkspace` check.
- **`template-sources` stays inside just-bash.** It is a storage detail
  of `justGitBackend`, and today the shared name rules, the workstation,
  and a `gitConformance` hook each know it.

**Evidence:** `workspaceConformance` and `gitConformance` on each
backend, the workbench tests on the new SQL options, and the export
snapshot of `@ambionframework/workspace`.

**C9. The host keeps one mechanism for each concern.**

- **A composition carries no `version`.** No other format exists. The
  refusal of the legacy assistant field in `journal/validate.ts` is a
  reader for an older format, and it goes with `version`.
- **One capture serves a definition.** `defineHuman` and `captureHuman`
  apply the same trim, and so do `defineAgent` and `captureAgent`.
- **One registry serves the waiters.** `waitForClose` runs the loop that
  `responseFor` runs, and `publish` notifies after each effect in place
  of eleven `notifyExchangeWaiters` calls placed by hand.
- **Cloudflare reuses the core.** `recoveryCall` and `releaseRecovered`
  repeat the call of the runner, `RoomObject.visits` repeats the visits
  of the room, and `reconcileRoom` repeats `Room.reconcile()`. Phase 2
  holds this sub-item.
- **One scripted room serves the conformance suites.** `scriptedRoom` and
  `executorRoom` merge, and the transport suite keeps the cases that a
  transport adds. `conformance.ts` and `conformance-executor-room.ts` each
  hold their own question, participants block, and `stale` constant; the
  merged room holds one of each, and `until` accepts an async predicate.
  This sub-item closes M5 of 0.2.0. Phase 2 holds it.

**Evidence:** the golden journals change for `version` alone, the
coverage of the core holds, and the Cloudflare tests pass in workerd.

**C10. One tool for `status` and `wait`.** `status` gives what `wait`
with a timeout of 0 gives. `ps` gives what `wait` with no handle and a
timeout of 0 would give. The process tools shrink to `bash`, `wait`, and
`cancel`, and the table of tool counts in `defaultToolGuidance` shrinks
with them. The acceptance of B in 0.3.0 and
[Processes](../docs/processes.md) name `status` and `ps`, so the item
rewrites both. **Evidence:** the process tests, the prompt snapshot, and
one live file on each harness that shows no loss in the use of a process.

**C11. One record for a live process in the table.** The table keeps a
process of this run and an adopted process in two maps, with two stop
paths and two end paths. One record with an optional controller removes
about 50 lines, and each fix to a stop then lands once. The two stop
mechanisms stay: an abort for a process of this run, since just-bash has
no pid, and the pid for an adopted process. A lost process keeps its
`pid` and no end file, so each listing runs `ps` for it until a start
forgets it. A `stop` line that the first read writes ends that cost.
**Evidence:** the process tests on just-bash and on the workstation, and
the adoption on OpenSSH.

**C12. The body schemas guard the journal.** Each `run` entry carries
`format`, and `validateRunFormat` refuses a format that the runtime does
not know. [Durability](../docs/durability.md#journal-format) states that
a body change raises the format and adds no reader for the older one. A
raise protects only a downgrade, and Ambion supports none. A raise also
refuses every journal of the release before. 0.3.0 changed three bodies
and kept format 1.

- **The format number goes.** `JOURNAL_FORMAT`, `Fence.format`, and
  `validateRunFormat` go, and a `run` entry carries `at` alone.
- **A schema refuses an old shape that a runtime would misread.** A body
  schema accepts extra fields, so an old field that a new runtime does
  not read disappears without an error. A change that removes or
  redefines a field makes its schema refuse the old field. The cancel
  schema of C3 refuses `close`. The composition of C9 needs no refusal,
  since no runtime reads `version`.
- **[Durability](../docs/durability.md#journal-format) states the rule.**
  The section names the schemas as the guard, and it states that Ambion
  supports no downgrade before 1.0.0.

**Evidence:** a journal validation case for each refused old shape, the
golden journals with no `format`, and `pnpm chaos` on both storages.

**A1. The assistant works a request after its owner leaves.** This item
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
  owner does not change the work. The assistant seats and routes as it
  does for a person who stays, and the closing summary goes to the owner.
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
