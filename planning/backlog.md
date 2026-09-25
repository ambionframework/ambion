# Backlog: after 0.3.0

Everything that is not in [next.md](next.md). The first section holds the
scope of 0.4.0. Each other item names the condition that brings it into a
release. Nothing here blocks the 0.3.0 tag.

## 0.4.0: one path for each fact

**0.4.0 is a release of simplification.** It adds no capability. It
removes each second path to a fact of the room, and it moves to
[next.md](next.md) when 0.3.0 tags. Every other item on this page waits
until after 0.4.0, unless its condition holds first.

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

**Journal format.** A close carries `cancelled`, a cancel entry carries
no close (C3), and a composition carries no `version` (C9).
[Durability](../docs/durability.md#journal-format) states that a body
change raises the format, so the release raises `JOURNAL_FORMAT` by one,
adds the golden journals of the new format, and adds no reader for the
older one.

**One decision stays open.** The `assistant` room option is shorthand
for `agents`, `summary`, and `broadcast` attention, and it adds its own
refusals. The owner decides whether one concept stays, with the
assistant's live suite as the evidence.

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

### The order of work

**Three phases.** Phase 1 changes no extension contract. Phase 2 changes
the hosting exports, the executor contract, an option of `defineAgent`,
and the process tools. A step names the steps it needs; a step with no
"Needs" line starts now.

#### Phase 1. The drift

- [ ] **1.** The fold becomes a test oracle, and `RoomState` exposes
      `due` alone. (C1)
- [ ] **2.** The copies of the verified rules go. (C2)
- [ ] **3.** A cancellation has one shape. Needs 1. (C3)
- [ ] **4.** A seat of an unknown executor kind fails at once, on each
      of the three routers. (C5)
- [ ] **5.** A composition carries no `version`, one capture serves a
      definition, and one registry serves the waiters. (C9)
- [ ] **6.** One record for a live process in the table. (C11)

**Evidence:** each step keeps `pnpm check` green and holds the coverage
of each changed package, measured before and after as `CLAUDE.md`
states. A step that changes a rule runs `pnpm rule:check`. A step that
changes a journal body updates the golden journals and the export
snapshot in the same commit, and the changelog names it. Steps 1, 3, and 5
pass `pnpm chaos` and the Cloudflare tests in workerd.

#### Phase 2. The contracts

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

#### Phase 3. Release

- [ ] **1.** `JOURNAL_FORMAT` rises with its golden journals, and the
      changelog entry for 0.4.0 names each export that changed and the
      count of lines removed. Needs phases 1 and 2.
- [ ] **2.** The live run on `main` after the last merge passes for Pi,
      Claude, and Codex. Needs 1.

### The items

**Each item removes one kind of second path.** Each states the problem,
the change, and the evidence.

**C1. One derivation of the room state.** `room/fold.ts` derives every
fact from the whole journal, and `room/projection.ts` derives the same
facts one entry at a time. Nearly every fact has a pair: `foldPeople`
and `advancePeople`, `openExchange` and `exchangeAfter`, `pendingWakes`
and `wakes.ts`, `foldScheduled` and `scheduleStep`. Production reads both:
`readRoom` in `room.ts` folds, and the live room advances the projection.

- **`readRoom` reads `projectState(replay(...))`.** `foldRoom` and
  `project` move to `test/support`, and `projection-equivalence.test.ts`
  keeps them as its oracle. The projection imports `applyEvent`, `older`,
  `BaseFacts`, `reseat`, and `reserveOf` from `fold.ts`, so those stay in
  `src/`.
- **`RoomState` exposes `due` alone.** Only tests read `pending` and
  `owed`. `PendingWake.seq`, `Owed.writer`, and `Owed.through` repeat
  other fields, and the `OwedEntry` and `WakeCandidate` wrappers go.
- **The open proof of unique roster names follows the projection.**
  [Proofs to write](#proofs-to-write) names `foldRoster`, and the proof
  states the rule for `rosterAfter` when `foldRoster` leaves `src/`.

The two read paths can no longer differ. **Evidence:** `pnpm chaos`
passes with the oracle in `test/support`, `golden.test.ts` compares
`projectState(replay(...))`, and `src/` holds no `foldRoom`.

**C2. One home for each rule.** A rule that the room decides by lives in
`rules.verified.ts`, and the caller runs its body. Some callers hold a
copy of the rule or feed it a constant.

- **The unverified copies go.** `cameToNothing` in `room/lease.ts`
  repeats a rule of `rules.verified.ts`, and `countsAgainst` serves both
  callers. `acknowledged` repeats the `Math.max` of `applyChange`, which
  alone keeps `readThrough` from moving back. `seatOf` in `lease.ts` and
  `seatOfLease` in `transition.ts` are one function.
- **`summaryVerdict` loses its constant input.** `summaryCompletion` in
  `room/exchange.ts` returns before the rule when a summary exists, so it
  passes `covered` as `false` every time, and the branch after the rule
  never runs. `covered` and the `published` arm go.
- **One search finds a covering summary.** `summaryCompletion`,
  `summariesOf`, and `isCoveringSummary` in `transition.ts` each search
  with `coversExchange`.
- **`answerView` reads the activation once.** It calls `activationSpec`
  twice and compares two seats that come from the same id.
- **The rules read one lease shape.** They read a lease as `Hold`,
  `Taken`, `Draft`, and `LiveLease`, and `takenOf`, `draftsOf`, and
  `liveLeases` convert between them. One `RuleLease` replaces the four.
  This sub-item re-proves the rules that read them, and it follows the
  cancelled close of C3, which changes what `Hold` holds. Phase 2 holds it.
- **The lease `since` takes its name in the same proof edit.**
  [Deferred by decision](#deferred-by-decision) holds the name until a
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

## Known defects

**K1. `python3` in a just-bash shell can abort at exit on Node 26.9.** On
macOS with Node 26.9.0 and `just-bash` 3.4.2, `python3` prints its output,
then can abort with "Fatal Python error: gilstate_tss_clear" and "python3:
Security violation: webassembly". The command exits 1, and the error text
joins the output. On 2026-09-24 it failed two gate runs in a row on the
owner's machine and passed the next one. The two tests that show it are
"runs js-exec and python3, and has no curl" in
`packages/just-bash/test/just-bash.test.ts` and the RFC 4180 export case in
`packages/workspace/test/sql.test.ts`. CI runs Node 22.19 and 26.4, and
both pass. The 0.2.0 release ran with `--skip-gate` for this reason. Find
how often it fails, and whether Linux on Node 26.9 fails too. Report it to
`just-bash` with the smallest command that fails. **Condition:** a user
report, a CI Node version at 26.9 or later, or the next release gate on
the owner's machine.

## Carried from 0.2.0

**L3. A billing failure reads as a billing failure.** Twenty-three red
live runs in a row had one cause, and each run read as a set of test
failures. Before the tests, each harness job makes one small request. A
billing or authentication refusal fails the job with an annotation that
names the provider error, and the tests do not run. **Condition:** the
next live run that fails on a provider refusal.

## Release hygiene

**R1. A repeatable release.** The 0.1.0 and 0.2.0 releases ran from one
machine with a passkey and a token, and `DEV_BASE` in `dev-release.yml:40`
is a literal. A trusted workflow with `id-token: write` publishes with
provenance and needs no token on a laptop. The dev stamp reads its base
from the last tag. **Condition:** a release that the owner does not run
from the owner's machine, or a user who asks for provenance.

- npmjs holds a trusted publisher setting for each of the eleven
  packages.

## Designs with a shape

**The checkpoint entry.** A checkpoint entry lets a resume skip settled
history, and full replay stays the reference. It is a format change, so it
lands with a golden journal of the new format. **Condition:** a measured
resume time comes near the default `limits.lease.ttl` of 60 seconds ([envelope.md](../docs/envelope.md)). Past
that point, replay sets the recovery time.

**Processes linked to the room, and more kinds of process.** A process runs
until it ends, times out, or gets a cancel
([Processes](../docs/processes.md)). An exchange closes when no activation is
live, so a cancel at the close stops a process at the first quiet moment. A
link to the room needs its own design. The handle is `<kind>-<random>`, and
`bash` is the one kind. A clone that runs past its call and a SQL export are
candidate kinds. The end of a process wakes no seat, by decision: the agent
waits, and a host can post a message
([Processes](../docs/processes.md#the-end-of-a-process)). The table has no
fence: two runs of the host over one account adopt the same processes.
**Condition:** a process that must stop with its exchange, or a second kind of
work that outlives its call.

**Three process changes from a comparison with Codex unified exec.** Codex
gives a model `exec_command` and `write_stdin` over a PTY, with sessions in
memory ([Processes](../docs/processes.md) holds the Ambion design). Three
of its mechanisms fit the process table and keep the five tools. The
output cursor, a fourth, landed in 0.3.0.

1. **An interactive kind of process.** A `pty-<random>` handle runs its
   command on a PTY, and an `input` tool writes to it, Ctrl-C included.
   The workstation gives the PTY. just-bash has none, so it refuses the
   kind. Today stdin is `/dev/null`, so a command that prompts waits until
   its timeout.
2. **A graceful cancel.** `cancel` and the timeout send `SIGTERM` to the
   group, and `SIGKILL` after the grace. Today a stop sends `SIGKILL`, so
   a server or a database gets no time to flush.
3. **The head and the tail in a result.** The result shows the first
   lines of the output beside the last ones. The first lines often hold
   the error that the last lines report.

**Condition:** an agent that must drive a prompt or a REPL. The
interactive kind comes first.

**Tool execution provenance beyond the activation.** `ToolContext` carries
the activation, the exchange, and the room. A purpose field, a retry-safe
operation key that the kernel derives, and a domain operation reused across
rooms wait. **Condition:** an application that needs one of the three.

**An `apply_patch` tool for Codex seats.** A Codex seat under
`nativeTools: 'none'` reaches files through the workspace `edit` tool, a
block-replace tool built for Pi. The Codex catalog patch removes
`apply_patch`, the tool Codex models are trained to call, so every edit
goes through a call shape the model was not tuned on. `@openai/agents-core`
exports `applyDiff`, a pure TypeScript function, MIT licensed, that parses
and applies one file section of the same patch grammar with no file I/O of
its own. What remains is an envelope parser for the full patch (`Add
File`, `Delete File`, `Update File`, `Move to`) and a tool that writes
each section through `FileSystem`, the interface `edit` already uses.
Such a tool then works on the memory backend, the directory backend, and
the workstation alike. A shell command such as `patch` or `git apply`
reads a different grammar, and only the workstation runs a real one, so it
buys the tool nothing that `FileSystem` and `applyDiff` do not already
give it. OpenAI's own Rust crate, `codex-rs/apply-patch`, holds the ground
truth grammar; a Python binding ships on PyPI as `codex-apply-patch`, but
neither reaches Node without a WASM build. **Condition:** a live
comparison of the `edit` tool against an `apply_patch` prototype, on the
same editing task, shows a real gain in tool-call success for a Codex
seat. Build the tool only after that measurement.

**A durable subscription service across processes.** Subscriptions belong
to one running host. A client that reconnects reads and reacquires its
handles. **Condition:** a placement that serves one room from more than one
process.

**A generated API reference.** One reference per entry, with a CI check
that fails when it is stale. **Condition:** an adapter or host author who
cannot work from the typed README examples and the export snapshot.

**A SQL backend over a database server.** `backend.sql` takes any
`SqlBackend` ([Workspace](../docs/workspace.md#query-the-shared-database)),
and the package ships `sqliteBackend`. A backend over a database server
connects as each agent with its own credential, so the server enforces the
grants. It passes `sqlConformance`. **Condition:** the lab setup, one workstation and
one database server, is scheduled.

**A git server on a second machine.** `workstationGitBackend` keeps the
git account on the workstation, and each agent key works only from the
loopback address ([Workstation git](../docs/workstation-git.md)). A lab
with a git server apart from the workstation needs the address that an
agent's `ssh` uses, the source addresses that `from` names, and an
OpenSSH tier with two machines. **Condition:** a lab with two or more
workstations that share one set of repositories.

**A backend profile and concurrent operations.** A backend declares its
isolation, its network, and whether the owner may run operations from two
agents at once. The owner then keeps one queue for each agent. The same
design decides which identity writes the audit log. It builds on
the workspace interface of 0.2.0 item M7. **Condition:** a workstation
run where one agent's command delays another agent's file tool.

## Proofs to write

[docs/formal.md](../docs/formal.md) states the mechanism and the line a
proof must pay for. These proofs are open, and none removes a known defect.

| Proof                 | What it states                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| The stop-loop measure | A measure that the stop loop decreases                                                          |
| The pass measure      | A measure that each reconciliation pass decreases, so the `PASSES` bound is a proof             |
| Unique roster names   | `reseated` and `foldRoster` keep one seat per name                                              |
| `seatLive`            | The seats that are live now, as a rule beside `exchangeLive`                                    |
| `storedIdAccepted`    | The kinds on which `validate.ts` reads an activation id; a refusal on others is a schema change |

The chaos drain and the walk's `drained` check witness the two measures
today. **Condition:** a fault that one of them would have caught.

## Deferred by decision

- Hot-loaded definitions; the definition set is fixed per run.
- Multiple simultaneous discussions within one room; separate rooms.
- Per-tab presence tokens and automatic departures; hosts reconcile.
- Distributed workspace ownership; one owner per resource.
- Automatic summary skipping by message count; manual summary retry.
- Exchange budgets; deadlines and caps bound activations only.
- Agent source retrieval and pagination under the shared summary policy.
- Browser-only execution, a managed service, arbitrary edge platforms,
  turnkey deployment commands, multiple terminal clients.
- A `SeatObject` class rename in the Cloudflare adapter; it needs
  Durable Object migration evidence.
- A provider-neutral plugin ecosystem beyond the executor contract.
- A second live-tier provider job. Add one only if a provider-specific
  defect turns up.
