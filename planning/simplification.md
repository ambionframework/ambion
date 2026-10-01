# Simplification: fewer concepts

**This page lists the concepts that the repository holds twice.** The
target shape is a set of parts where the removal of any one part breaks
the whole. A concept stays when a test or a reader needs it. A concept
goes when another concept already carries its meaning.

**The review read every source file of the eleven packages.** It covers
the core room layer, the three executors, the workspace, the two
backends, the journal, the Cloudflare adapter, the simulator, the
assistant, and the workbench example. An independent audit then checked
each row against commit `bec6b6f`. [The backlog](backlog.md) and
[the plan](next.md) keep their roles. This page feeds items into them.

**Four findings came from the owner.** They are the executor
registration (done), the room acquisition (done), the Pi types in the
workspace port (W1), and the repository registration (B1).

## How a row is ranked

**A concept is a name that a reader must learn.** It is a type, an
exported name, an option, a mechanism, or a term. Lines saved do not
count.

**The rank is the concepts removed times the confidence.** High counts
3, medium counts 2, and low counts 1. A row with no concept to remove,
such as a defect, has no rank. The phases below take the rank, the risk,
and the order of the dependencies together.

## Done

**Eleven reductions have landed.** `pnpm check` passes on them, and the
changelog names each change to an export and to a behavior.

| Change                                      | Concepts removed                                                         | Files                                    |
| ------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------- |
| One shape of a say that waits               | `ScheduledSay`, `pendingSay()`                                           | `room/scheduled.ts`, `scheduling.ts`     |
| One read of the pending says and waits      | `room.pendingFor()`, `room.scheduled()`, `RoomObject.scheduledSays()`    | `room-host/room.ts`, `room-object.ts`    |
| One acquisition of a room name              | The second copy of build, register, start, and release on failure        | `room.ts` (`acquire`)                    |
| One call defines an executor family         | The `*Build` closures, `localExecution` in adapters, two option aliases  | `execution/route.ts`, `compose.ts` ×3    |
| One wrapper audits every tool (W3)          | `recordedOnShell`, the audit code of `bindTool`, the `audit` options     | `tools.ts`, `workspace.ts`               |
| One shape holds each capability (W2)        | `sqlPart`, `gitPart`, `sensorTools`, `workspaceReminder`, the name lists | `capability.ts`, `workspace.ts`          |
| One harness for the conformance suites (W4) | Four harness types, six `check` copies, the hand-written case runners    | `journal/src/conformance.ts`, the suites |
| One registration state machine (B1)         | Two register pairs, two name and path checks, two equal-tree decisions   | `workspace/src/git-registration.ts`      |
| One file adapter for the backends (B3)      | Two `attempt` helpers, two `FileResult` types, 26 member bodies          | `workspace/src/execution-env.ts`         |
| One rule for a thrown pass (E2)             | `UnknownModel`, a second `PermanentError`, six copies of the conversion  | `execution/failure.ts` (`failedPass`)    |
| One function opens a session (E3)           | `Executor.harness`, `Executor.open`, three public `create*Executor`      | `execution/executor.ts`, `activation.ts` |

**The fold, a view, and a read now hold one `PendingSay`.** Its `due` is
ISO, and the reconcile parses it. A view and a read clone it, so no
caller shares the state of the fold.

**Every tool call now follows one audit rule.** `workspaceTools` passes
each tool of the bundle through `audited`. The entry is one more
operation on the bash owner after the call ends, and a call with invalid
arguments has an entry. A call that ends after `dispose` starts has no
entry, and the log's `onError` receives the loss. An adversarial review
found that loss, and the fix reports it through the existing channel.

**An adapter now learns one kernel concept to register.**
`defineExecution(kind, build)` returns the options-to-execution function
and registers the default. `localExecution` stays for an execution that
is not a family, such as `examples/workbench/src/unavailable.ts`.

## The kernel: `packages/ambion`

| ID  | Finding                                                            | Evidence                                                                                                 | Removes | Conf.  | Rank |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------- | ------ | ---- |
| K1  | Readers of older formats remain, which CLAUDE.md forbids           | Bare keys (`durability.md:272`), `removed` fields (`validate.ts:29`), run-less entries (`journal.ts:93`) | 3       | High   | 9    |
| K2  | One runtime has five facets                                        | `Runtime`, `ExecutionHost`, `Hosting`, `RuntimeState`, `RoomRuntime` (`runtime.ts:53-249`)               | 3       | High   | 9    |
| K3  | The commit result has two forms                                    | `CommitOutcome`, `classifyCommit` (`protocol.ts:190-204`); one caller                                    | 2       | High   | 6    |
| K4  | The hosting entry exports 16 names that no package or test imports | `SAY`, `SEAT`, `DEFAULT_TRACE`, `Hosting`, `Stale`, `RoomToolResult`, and others                         | 16      | High   | 48   |
| K5  | Usage addition exists three times                                  | `addUsage` (`types.ts:463`, not exported), `sum` in Pi, `total` in the simulator                         | 2       | High   | 6    |
| K6  | A body shape is written as a type and again as a schema            | `events.ts`, `validate.ts`; a third ended lease in `protocol.ts:206-217`                                 | 3       | Medium | 6    |
| K7  | Three rules state "plain data", and they disagree                  | `Cloneable` allows `Date` (`journal.ts:109`); storage needs JSON; `assertWire`                           | 2       | Medium | 4    |
| K8  | Three renderers write one line of the record                       | `record.ts:29`, `execution/render.ts:54`, `simulator/src/render.ts:29`                                   | 2       | Medium | 4    |
| K9  | The `assistant` option restates `agents`, `seats`, and `summary`   | `normalizeAssistant` (`room.ts:231`); the package is 70 lines over `pi()`                                | 2       | Medium | 4    |
| K10 | Five close shapes serve one fact                                   | `SummaryClose` (`exchange.ts:85`) and the `OwedClose` alias (`owed.ts:43`) go                            | 2       | High   | 6    |
| K11 | Three state shapes hold the fold                                   | `RoomState`, `RoomProjection`, `BaseFacts`; `applyEvent` has two callers                                 | 1       | Medium | 2    |
| K12 | The wakes and the owed summaries are two parallel indexes          | `wakes.ts`, `owed.ts`, `seatLeases`, `closedLeases`; the rules differ                                    | 3       | Low    | 3    |
| K13 | The journal keeps a `seq` beside a dense storage position          | `nextSeq`, `advanceSeq`, `scanned` (`rules.verified.ts:49-71`)                                           | 2       | Medium | 4    |
| K14 | The journal package generics have one consumer                     | Outside the core, only the storage names are imported                                                    | 4       | Low    | 4    |
| K15 | The roster has two stored sources                                  | Backlog D7                                                                                               | 1       | Medium | 2    |
| K16 | The room host has five views over one class                        | `RoomBase`, `ControlHost`, `DispatchHost`, `PeopleHost`, `WaitsHost`; members repeat                     | 4       | Medium | 8    |
| K17 | Six names describe one exchange                                    | `ExchangeRef`, `ClosedExchange`, `ExchangeView`, `ClosedExchangeView`, `ExchangeRead`, `ExchangeHandle`  | 2       | Medium | 4    |
| K18 | Three shapes describe one trace sink                               | `TraceSink`, `StepSink`, `TraceOpener` (`trace.ts:33-59`)                                                | 1       | Medium | 2    |

**K1 drops a promise.** `docs/durability.md:272` says that a key with no
prefix reads as written. A read-only journal also opens with no run
(`room.ts:156`), so the run-less path needs a check before it goes.

**The deepest kernel option is a close as a message.** A close that
routes to the summary writer makes the summary an ordinary respond
activation. The `closed` activation source, `owed.ts`, `closedLeases`,
`closeFor`, and the second purpose then go. The verified rules, the
golden journals, and the authority of a summary change with it. It stays
a design note until a second reason for it appears.

## One name rule across the repository

**X1 is one rule written fourteen times.** It is in three packages and
the workbench. Rank 12: 4
concepts, high confidence.

| Where           | Copies                                                                           |
| --------------- | -------------------------------------------------------------------------------- |
| The core        | `NAME_PATTERN` (`define.ts:520`), `SEAT` (`activation-id.ts:17`)                 |
| The workspace   | Nine literals in seven sensor files, `NAMESPACE` (`git-names.ts:24`)             |
| The workstation | The name group of the serve pattern (`git-prepare.ts:40`)                        |
| The workbench   | `ROOM_NAME` (`names.ts:1`), with a length bound of 48 that the core does not set |

## The executors: `pi`, `claude`, `codex`

| ID  | Finding                                                        | Evidence                                                                                    | Removes | Conf.  | Rank |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------- | ------ | ---- |
| E1  | The steer bookkeeping is in each executor                      | `Held` in `pi/executor.ts:93` and `claude/executor.ts:71`                                   | 3       | High   | 9    |
| E2  | A thrown error becomes a transient pass in five places (done)  | `runner.ts:507`, `activation.ts:49`, Pi, Claude, Codex; `UnknownModel` and `PermanentError` | 3       | High   | 9    |
| E3  | `Executor.harness` always equals the executor kind (done)      | `pi:85`, `claude:63`, `codex:94`                                                            | 2       | High   | 6    |
| E4  | Pi has three option types for its services                     | `services.clock`, `.call`, and `.trace` are written and never read                          | 4       | High   | 12   |
| E5  | The kind narrowing and the policy copy are written three times | `POLICY` and `policyOf` twice, `present()` twice, `modelOf`                                 | 3       | Medium | 6    |
| E6  | A pass carries `tools` and `agentTools` apart                  | Claude and Codex join them; Pi rebuilds (`pi/tools.ts:88-102`)                              | 3       | Medium | 6    |
| E7  | Two scripted test languages export the same six verbs          | `ambion/testing/scripted.ts`, `pi/testing.ts`                                               | 5       | Medium | 10   |
| E8  | Small helpers repeat                                           | `ROOM_SERVER` ×2, the content union ×3, the text join of a tool result ×5                   | 4       | Medium | 8    |

**E1 hides a defect.** `ActivationState.steer` (`activation.ts:116`)
drops a steer when the executor has no `steer`. A Codex seat then stamps
no `steer` step. `docs/executors.md:275` says that every family stamps
one, and `docs/executors.md:143` says that a steer is optional.

**The core name `Turn` breaks the glossary.** `testing/scripted.ts:22`
exports `Turn` for a scripted reply. CLAUDE.md gives `turn` to Pi. E7
takes the core type into the Pi test language, so the rename comes first.

**The `pi()` and `piExecution()` split stays.** `pi()` is a definition
value that the room captures. `piExecution()` carries host services. One
definition runs on different executions in
`examples/workbench/src/rooms.ts` and `cloudflare/src/configure.ts`.

## The workspace: `packages/workspace`

| ID  | Finding                                                                | Evidence                                                                | Removes | Conf.  | Rank |
| --- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------- | ------ | ---- |
| W1  | The workspace port is Pi's type                                        | 36 source files import `pi-agent-core`; `index.ts:34` re-exports it     | 1       | High   | 3    |
| W2  | Each capability repeats one pattern (done)                             | `sqlPart`, `gitPart`, `sensorTools`; hand-kept tool name lists          | 6       | High   | 18   |
| W3  | Two wrappers audit a tool, under two placement rules (done)            | `bindTool`, `recordedOnShell`; 13 tools write their name twice          | 2       | High   | 6    |
| W4  | Seven conformance suites each have a `check` and a harness type (done) | Five `check` copies; the suites already share `ConformanceCase`         | 3       | High   | 9    |
| W5  | The sensor path validates at every layer                               | The client and the retention both check the schema and the digest       | 2       | Medium | 4    |
| W6  | The sensor connections keep a second liveness table                    | `endedProcesses` (`sensor-connections.ts:70`); `hostList`, `hostCancel` | 3       | Medium | 6    |
| W7  | Two owners close the sensor connections (kept)                         | `workspace.ts:364` and `workspace.ts:517`                               | 0       | High   | —    |
| W8  | The backends label themselves under four names                         | `database`, `server`, `store`, `hostname`                               | 2       | Medium | 4    |
| W9  | Refs, logs, and constants repeat                                       | See the list below                                                      | 5       | High   | 15   |
| W10 | `ProcessKind` has one value                                            | `process-files.ts:23`; backlog D5 holds the question                    | 1       | Medium | 2    |

**W1 is larger than the re-export.** The workspace also takes its
environment port, its file errors, and its shell results from Pi. The
rank counts one concept, but the row fixes a package boundary. CLAUDE.md
states that `packages/workspace` owns the workspace port. Backlog K6, the
neutral-file import rule, is the check that holds it.

**The owner decided W1: the workspace owns its port.** The work stays in
phase 3 for its size. Each change before it adds no import of
`@earendil-works/pi-agent-core`.

**W3 leaves `withSkills` to W2.** `withSkills` copies the skills at the
first call of an agent. It audits nothing.

**W2 covers the bundle.** A `Capability` holds tools, notes, and a
reminder. One composer orders the capabilities, and it writes the tool
line from the names of the tools. `withSkills` keeps its first-call copy
and uses the same helpers for its guidance and its reminder. The owners,
their dispose order, and the host methods stay explicit. Each owner has
its own wiring, and the dispose order is a rule of its own. A generic
`close` or `host` field removes no concept.

**W7 stays.** The close in `dispose` stops pending sensor connects at
once, even while the bash owner is busy. The close in `withProcesses`
makes the processes wait until the connections close. `close()` returns
the same promise twice, so each call has a purpose and no work repeats.

**W9 holds five small duplicates.**

- The ref length check and the workspace check: `snapshots.ts:140,209`
  and `git-refs.ts:41,63`.
- `audit.ts` rebuilds `openLog` and names `rotateBytes` as `maxBytes`.
- The timer ceiling `2_147_483` five times, under two names:
  `sqlite.ts:100`, `process-tools.ts:63`, `process-run.ts:36`,
  `workstation/backend.ts:42`, `workstation/exec.ts:45`.
- `digestOf` three times, and byte formatting three times.

## The backends: `just-bash` and `workstation`

| ID  | Finding                                                           | Evidence                                                           | Removes | Conf.  | Rank |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------ | ------- | ------ | ---- |
| B1  | Repository registration is one state machine written twice (done) | `just-bash/git/registration.ts`, `workstation/git-registration.ts` | 1       | High   | 3    |
| B2  | A transport pairing guards a mismatch that one factory prevents   | `GitAccess.transport`, `BashBackend.gitTransports`, `BashServices` | 3       | Medium | 6    |
| B3  | The file adapter skeleton is written twice (done)                 | `bash-env.ts:42,83`, `ssh-env.ts:56,65,111`                        | 2       | High   | 6    |
| B4  | Git constants repeat                                              | `DEFAULT_BRANCH` ×2, the `ambion` author ×4                        | 2       | High   | 6    |

**B1 closed a gap.** The just-bash backend accepted a source path such
as `../x` or `.git/config` and stored it in the tree. The shared path
check now refuses it on both backends.

**B1 is one concept of about 300 lines.** Each file validates names,
compares trees, creates or updates a template, seeds a shared repository
once, and recovers an interrupted seed. Only the storage mechanics
differ.

**The push policy stays in both servers.** The TypeScript server and the
bash server each accept pushes, so each enforces the policy.

## The adapters, the simulator, and the workbench

| ID  | Finding                                                          | Evidence                                                                   | Removes | Conf.  | Rank |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- | ------- | ------ | ---- |
| C1  | Cloudflare keeps the room name and agent names in a second store | `RoomMetadata` (`storage.ts`); `SeatMetadata.wakes` and `cuts` serve tests | 3       | Medium | 6    |
| C2  | `RoomObject` forwards three methods of the exchange handle       | `room-object.ts:231-244`                                                   | 2       | Low    | 2    |
| S1  | The simulator and the workbench write helpers the platform has   | `deadlineSignal` (`simulator/signal.ts:2`), `formatUsage` (`steps.ts:56`)  | 2       | Medium | 4    |

**C1 keeps the seat state.** `SeatMetadata.activation`, `phase`, and
`hold` are state of their own.

## The documentation

| ID  | Finding                                                                | Evidence                                                                   |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| D1  | About eight paragraphs repeat across pages                             | Shared option rows and troubleshooting in `pi.md`, `claude.md`, `codex.md` |
| D2  | `resources.md` overlaps `workspace.md`                                 | `resources.md:4,150` say "two bindings"; seven backend factories exist     |
| D3  | "Envelope" has three meanings                                          | `envelope.md`, `durability.md`, `formal.md`                                |
| D4  | `durability.md` and `deployment.md` both describe leases and reconnect | The two pages each state the lease, alarm, and SQLite rules                |

**Four statements of the documentation do not match the code.**

- `docs/pi.md:27` said that Cloudflare builds its seats on
  `createPiExecutor`. E3 fixed it.
- `docs/pi.md:164` says that `thinkingLevel` is always `off`. The
  `thinking` option exists in `pi/src/define.ts:27`.
- `docs/codex.md:326` said that a missing binary is a transient failure.
  E2 fixed it.
- `docs/executors.md:275` says that every family stamps a `steer` step. A
  Codex seat stamps none (E1).

**Two planning records are missing from the CLAUDE.md table.** The
table names `next.md` and `backlog.md`. `review-0.5.0.md` and this page
also exist.

## The backlog items that reduce concepts

| Backlog | Relation to this page                                                             |
| ------- | --------------------------------------------------------------------------------- |
| P1      | Moves `returnable` into the verified rules; the first done change edits that file |
| K6      | The import rule that keeps W1 fixed                                               |
| D5      | Owns the `ProcessKind` question of W10                                            |
| D7      | Is K15                                                                            |
| D20     | A generated API reference gives K4 its evidence                                   |

## The order of the work

**Phase 1 removes names and fixes defects.** It changes no design. Each
item is one commit that updates the export snapshot and the changelog.

1. K4, K3, K5, K10: the kernel exports, aliases, and helpers.
2. E4, E5, E8, W9, W10, B4, S1: the executor, workspace, and backend
   constants and helpers.
3. The rename of the core `Turn` and the four documentation defects.

**Phase 2 merges one mechanism at a time.** Each item keeps coverage, as
CLAUDE.md requires for a change that merges tests.

1. X1: one name rule, exported by the core.
2. W3, W2, and W4 are done.
3. B1 and B3 are done: the registration step and the file adapter.
4. E1, E2, E3: the steer, the failure, and the executor level.
5. K2 and K16: one runtime state and one room host view.
6. E7: one scripted test language. It depends on the `Turn` rename.

**Phase 3 needs a decision of the owner.** Each item changes a package
boundary, a stored format, or a promise.

- W1: the workspace owns its port, and the Pi executor adapts it. The
  owner decided it; the size keeps it in this phase.
- K1: the journal reads only the current format. It drops the promise of
  `docs/durability.md:272`.
- K9: the assistant moves beside Pi, and the room option goes.
- K6, K7: the schema is the one source of a body, and JSON is the one
  rule of plain data.
- K13, K14: `seq` is the storage position, and `Journal` moves into the
  core.
- B2, C1: one factory for each deployment, and no second store in
  Cloudflare.

## Considered and kept

**Each of these looks like a duplicate and carries a meaning of its own.**

- The unions that `rules.verified.ts` declares again, such as `Source`
  beside `ActivationSource`. LemmaScript lowers only the types of its own
  file, and `rules.test.ts` pins each copy.
- `startRoom` and `resumeRoom` as public calls. A start writes a
  composition, and a resume keeps the recorded one. They share one
  transaction.
- `visit.send` and `room.post`. A send has an author, and a post is a
  message of the system.
- `sqlite.ts` and `sqlite-guard.ts`. They are one concept in two files.
- The port suite and the executor suite of the core. Cloudflare runs the
  port suite. Every suite already returns `ConformanceCase[]` and runs in
  one loop.
- `localExecution`. A host needs one execution of a kind that is not a
  family.
- The scripts in `scripts/`. `packages.mjs`, `release-lib.mjs`, and
  `publish.mjs` each hold one concern.
