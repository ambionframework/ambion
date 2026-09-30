# Simplification: fewer concepts

**This page lists the concepts that the repository holds twice.** The
target shape is a set of parts where the removal of any one part breaks
the whole. A concept stays when a test or a reader needs it. A concept
goes when another concept already carries its meaning.

**The review read every source file of the eleven packages.** It read the
core room layer, the three executors, the workspace, the two backends,
the journal, the Cloudflare adapter, the simulator, and the assistant. It
also takes four findings of the owner. Each finding cites the files where
the duplicate lives. [The backlog](backlog.md) and
[the plan](next.md) keep their roles. This page feeds items into them.

**A rank is the number of concepts removed times the confidence.** A
concept is a type, an exported name, an option, a file of rules, or a
mechanism that a reader must learn. Lines saved do not count.

## Done in this change

**Four reductions landed with this page.** `pnpm check` passes on them.
The changelog names each change to an export.

| Change                                 | Concepts removed                                                                                         | Files                                                          |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| One shape of a say that waits          | `ScheduledSay`, `pendingSay()`. The fold, a view, and a read hold `PendingSay`                           | `room/scheduled.ts`, `scheduling.ts`                           |
| One read of the pending says and waits | `room.pendingFor()`, `room.scheduled()`, `RoomObject.scheduledSays()`. Each restated `room.read()`       | `room-host/room.ts`, `cloudflare/src/room-object.ts`           |
| One acquisition of a room name         | The second copy of the start transaction: build, register, start, and release on failure                 | `room.ts` (`acquire`)                                          |
| One call defines an executor family    | `localExecution` plus a `*Build` closure in each adapter, and the `Claude/CodexExecutionOptions` aliases | `execution/route.ts`, `pi`, `claude`, and `codex` `compose.ts` |

**An adapter now learns one kernel concept to register.**
`defineExecution(kind, build)` returns the options-to-execution function
and registers the default. `localExecution` stays for an execution that is
not a family, such as the stub in `examples/workbench/src/unavailable.ts`.

## The kernel: `packages/ambion`

| ID  | Finding                                                                                                                                                                                                                                                                     | Removes | Confidence |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| K1  | **Readers of older formats remain.** `unspaced` reads a key with no prefix (`journal/journal.ts`, and the key rule of `docs/durability.md`). `validate.ts` refuses `removed` fields. The journal accepts entries "from before runs were fenced". CLAUDE.md forbids each one | 3       | High       |
| K2  | **One runtime has five facets.** `Runtime`, `Hosting`, `ExecutionHost`, `RoomRuntime`, and `RuntimeState` (`host/runtime.ts:53-265`) read the same state. Cloudflare builds a throwaway runtime to get the default limits (`cloudflare/src/configure.ts`)                   | 3       | High       |
| K3  | **The commit result has two forms.** `CommitOutcome` and `classifyCommit` (`protocol.ts:190-204`) have one caller, `room-tools.ts`. Inline them                                                                                                                             | 2       | High       |
| K4  | **The hosting entry exports about twenty names that no consumer imports.** Among them: `SAY`, `SCHEDULE`, `SEAT`, `UNSEAT`, `DISMISS`, `RECALL`, `DEFAULT_TRACE`, `refusal`, `summaryToolDescription`, `PERMANENT_STATUS`, `renderLine`, `Hosting`, `Stale`                 | ~20     | High       |
| K5  | **Usage addition exists three times.** `addUsage` (`types.ts`) is not exported, so `pi/src/run-agent.ts` (`sum`) and `simulator/src/simulate.ts` (`total`) write their own                                                                                                  | 2       | High       |
| K6  | **A body shape is written twice.** The TypeScript types (`journal/events.ts`, `types.ts`) and the TypeBox schemas (`journal/validate.ts`) state each body. The ended lease has a third copy in `LeaseRequest` (`protocol.ts`). Derive the types with `Static<>`             | 3       | Medium     |
| K7  | **Three rules state "plain data".** `Cloneable` in the journal allows `Date` and `bigint`. The storage contract and SQLite need JSON. `assertWire` in `protocol.ts` states the JSON rule. Keep one `Json` type and one check                                                | 2       | Medium     |
| K8  | **Three renderers write one line of the record.** `record.ts`, `execution/render.ts`, and `simulator/src/render.ts` (`messageLine`)                                                                                                                                         | 2       | Medium     |
| K9  | **The `assistant` room option is a second way to write `agents`, `seats`, and `summary`.** `room.ts` expands it. The 70-line package holds two prompts and a `defineAgent(pi(...))`. Move `defineAssistant` beside Pi, have it return the three fields, and drop the option | 2       | Medium     |
| K10 | **Five close shapes serve one fact.** `Close`, `CloseRef`, `CloseFact`, `SummaryClose`, and `OwedClose`. `CloseRef` and `CloseFact` stay, because LemmaScript lowers only the types in its own file. `SummaryClose` and the `OwedClose` alias go                            | 2       | High       |
| K11 | **Three state shapes hold the fold.** `RoomState`, `RoomProjection`, and `BaseFacts`. `applyEvent` in `fold.ts` serves the cancellation step and the test oracle only                                                                                                       | 1       | Medium     |
| K12 | **The wakes and the owed summaries are two parallel indexes.** `wakes.ts` and `owed.ts` each judge, re-judge, and index leases (`seatLeases`, `closedLeases`). `PendingActivation` already unifies their output. The rules differ, so a merge shares only the index         | 3       | Low        |
| K13 | **The journal keeps a `seq` beside a dense storage `position`.** Gaps in `seq` are already allowed. `seq := position` drops a stored field and two verified rules, and the proofs need rework                                                                               | 2       | Medium     |
| K14 | **The journal package generics have one consumer.** `Vocabulary`, `Bodies`, `Entries`, and the `Append*` types serve `roomJournal` alone. Cloudflare and the workbench use only the storage side                                                                            | 4       | Low        |
| K15 | **The roster has two stored sources.** Backlog D7 holds the design: a seating for each seat at a start, and no `agents` in the composition                                                                                                                                  | 1       | Medium     |

**The deepest kernel option is a close as a message.** A close that routes
to the summary writer as a message makes the summary an ordinary respond
activation. The `closed` activation source, `owed.ts`, `closedLeases`,
`closeFor`, and the second purpose then go. The cost is large: the verified
rules, the golden journals, and the authority of a summary change. Keep it
as a design note until a second reason for it appears.

## The executors: `pi`, `claude`, `codex`

| ID  | Finding                                                                                                                                                                                                                                                                                                         | Removes | Confidence |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| E1  | **The steer bookkeeping is in each executor.** `Held` and `flush(through)` are the same in `pi/src/executor.ts` and `claude/src/executor.ts`. `ActivationState.steer` drops a steer when the executor has no `steer`, so a Codex seat records no `steer` step. `docs/executors.md` says every family stamps one | 3       | High       |
| E2  | **A thrown error becomes a transient `PassResult` in five places.** Pi, Claude, Codex, `activation.ts`, and `runner.ts`. Pi has `UnknownModel` and Codex has `PermanentError` for one idea. Export one `PermanentError` and classify in `ActivationState.pass`                                                  | 3       | High       |
| E3  | **The `Executor` level repeats the per-seat closure.** `Executor.harness` always equals the executor kind. `Executor` can be a function from an activation to a session                                                                                                                                         | 2       | High       |
| E4  | **Pi has three option types for its services.** `PiExecutionOptions`, `ExecutionServicesOptions`, and `PiExecutorOptions`. `ExecutionServices.clock`, `.call`, and `.trace` are never read                                                                                                                      | 4       | High       |
| E5  | **The kind narrowing and the policy copy are written three times.** `POLICY` and `policyOf` in Claude and Codex, `present()` twice, and Pi `modelOf` beside `executorOfKind`                                                                                                                                    | 3       | Medium     |
| E6  | **A pass carries `tools` and `agentTools` apart.** Claude and Codex join them at once. Pi rebuilds its tools from `AmbionTool`. A `RoomTool` with the full `ToolResult` gives one tool shape                                                                                                                    | 3       | Medium     |
| E7  | **Two scripted test languages share their verbs.** `@ambionframework/ambion/testing` and `@ambionframework/pi/testing` both export `callTool`, `speak`, `later`, `quiet`, `byAgent`, and `isClosing`. The Pi stream can take the core `Turn`                                                                    | 5       | Medium     |
| E8  | **Small constants repeat.** `ROOM_SERVER` twice, the tool content union three times, and the "join the text of a tool result" helper three times                                                                                                                                                                | 3       | Medium     |

**The `pi()` and `piExecution()` split stays.** `pi()` is a definition
value that the room captures. `piExecution()` carries host services. One
definition runs on different executions in `examples/workbench/src/rooms.ts`
and `cloudflare/src/configure.ts`.

## The workspace: `packages/workspace`

| ID  | Finding                                                                                                                                                                                                                                                                                                                                        | Removes    | Confidence  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------- |
| W1  | **The workspace port is Pi's type.** 36 source files of `workspace`, `just-bash`, and `workstation` import `@earendil-works/pi-agent-core`: `ExecutionEnv`, `Context`, `BACKGROUND_CONTEXT`, `withAbortSignal`, `FileError`, and the shell result types. `index.ts` re-exports `BACKGROUND_CONTEXT`. A Claude or Codex host meets a Pi concept | 1 large    | High        |
| W2  | **Each capability repeats one pattern.** SQL, git, and sensors each add an optional backend, an owner, tools with a hand-kept list of names, guidance, host methods, and a close. One `Capability { tools; guidance?; remind?; close?; host? }` covers them and processes, snapshots, and skills                                               | 6          | High        |
| W3  | **Three wrappers audit a tool.** `bindTool`, `recordedOnShell` (`tools.ts`), and `withSkills` (`workspace.ts`). Thirteen tools write their name twice. One `audited(tool)` reads `tool.name`                                                                                                                                                   | 2          | High        |
| W4  | **Seven conformance suites have seven runners.** Each has its own `check`, its own case runner, and its own harness type name. One `Harness<S>`, one `suite`, and one `check` beside the journal's `ConformanceCase`                                                                                                                           | 6          | High        |
| W5  | **The sensor name rule is written nine times.** `^[a-z][a-z0-9-]*` is in `resource.ts`, `sensors.ts`, `connect-tool.ts`, `observe-tool.ts`, `sensor-client.ts`, `sensor-connections.ts`, and `sensor-retention.ts`. `sensors.ts` encodes the git name rules again as schema patterns                                                           | 3          | Medium-high |
| W6  | **The sensor connections keep a second liveness table.** `SensorConnections` tracks ended processes that the `ProcessTable` already knows. `ProcessTable` has agent and host variants of `list` and `cancel`, and `WorkspaceProcesses` wraps them a third time                                                                                 | 3          | Medium      |
| W7  | **Two owners close the sensor connections.** `withProcesses` and `dispose` in `workspace.ts` both call `connections.close()`                                                                                                                                                                                                                   | 0 (defect) | High        |
| W8  | **The backends label themselves under four names.** `database`, `server`, `store`, and `hostname`. `BashBackend.connect` and `SqlBackend.connect` take their arguments in different orders                                                                                                                                                     | 2          | Medium      |
| W9  | **Refs, logs, and utilities repeat.** The own-ref check in `snapshots.ts` and `git-refs.ts`. `audit.ts` rebuilds `openLog` and names `rotateBytes` as `maxBytes`. `MAX_TIMEOUT_SECONDS` five times, `digestOf` three times, byte formatting three times                                                                                        | 5          | High        |
| W10 | **`ProcessKind` has one value.** It is carried in `kind`, in the handle prefix, and in `docs/processes.md`                                                                                                                                                                                                                                     | 1          | Medium      |

**W1 is larger than the re-export.** The owner's finding names
`BACKGROUND_CONTEXT`. The workspace also takes its environment port, its
file errors, and its shell results from Pi. The workspace must own a
minimal port of its own. The Pi executor then adapts that port. CLAUDE.md
already states that `packages/workspace` owns the workspace port.

## The backends: `just-bash` and `workstation`

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                     | Removes | Confidence |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| B1  | **Repository registration is one state machine written twice.** `just-bash/src/git/registration.ts` and `workstation/src/git-registration.ts` each validate names, compare trees, create or update a template, seed a shared repository once, and recover an interrupted seed. A pure `registrationStep()` in `workspace/git` decides; each backend applies | 1 large | High       |
| B2  | **A transport pairing guards a mismatch that one factory prevents.** `GitAccess.transport`, `BashBackend.gitTransports`, `BashServices`, and the check in `workspace.ts`. One factory for each package returns `{ bash, git }`                                                                                                                              | 3       | Medium     |
| B3  | **The file adapter skeleton is written twice.** `FileResult<T>`, `attempt`, and `toFileInfo` in `just-bash/src/bash-env.ts` and `workstation/src/ssh-env.ts`. Move it into `HomeEnv` with a `classify` hook                                                                                                                                                 | 2       | High       |
| B4  | **Git constants repeat.** `DEFAULT_BRANCH` twice and the `ambion` author four times. The serve script hard-codes the name pattern of `git-names.ts`                                                                                                                                                                                                         | 2       | High       |

**The push policy stays in both servers.** The TypeScript server and the
bash server each enforce it, because each accepts pushes.

## The adapters and the documentation

| ID  | Finding                                                                                                                                                                                                   | Removes | Confidence |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------- |
| C1  | **Cloudflare keeps a second durable store.** `MetadataStore` repeats the room name and the agent names that the journal holds. Only `stopped` is new. `SeatMetadata.wakes` and `cuts` exist for the tests | 3       | Medium     |
| C2  | **`RoomObject` repeats the exchange handle.** `exchange`, `waitForClose`, and `waitForSummary` forward to the handle                                                                                      | 2       | Low        |
| D1  | **Three pages repeat the shared executor options and the troubleshooting rows.** `pi.md`, `claude.md`, and `codex.md`. Keep them once in `executors.md`                                                   | 0       | High       |
| D2  | **`resources.md` overlaps `workspace.md`.** It says "two bindings" where the code has four backends                                                                                                       | 1 page  | Medium     |
| D3  | **"Envelope" has three meanings.** The journal envelope, the fold cost page `envelope.md`, and the verified rule envelope. Rename the page `limits.md`                                                    | 1 term  | Medium     |

**Four statements of the documentation do not match the code.**

- `docs/pi.md` says that Cloudflare builds its seats on
  `createPiExecutor`. `cloudflare/src/configure.ts` uses `piExecution`.
- `docs/pi.md` says that `thinkingLevel` is always `off`. The `thinking`
  option exists in `pi/src/define.ts`.
- `docs/codex.md` says that a missing binary is a transient failure.
  `codex/src/catalog.ts` throws `PermanentError`.
- `docs/executors.md` says that every family stamps a `steer` step. A Codex
  seat stamps none (E1).

## The order of the work

**Phase 1 removes names with no design change.** Each item is one commit
that updates the export snapshot and the changelog.

1. K1, K3, K4, K5, K10: the kernel readers, aliases, and exports.
2. E4, E5, E8, W9, W10, B4: the executor and backend constants.
3. W7 and the four documentation defects.

**Phase 2 merges one mechanism at a time.** Each item keeps coverage, as
CLAUDE.md requires for a change that merges tests.

1. W3, then W4: one audited tool, then one conformance harness.
2. B1 and B3: the registration step and the file adapter.
3. E1, E2, E3: the steer, the failure, and the executor level.
4. K2: one runtime state with one host view.
5. W2: one capability shape. It depends on W3.

**Phase 3 needs a decision of the owner.** Each item changes a package
boundary or a stored format.

- W1: the workspace owns its port, and the Pi executor adapts it.
- K9: the assistant moves beside Pi, and the room option goes.
- K6, K7: the schema is the one source of a body, and JSON is the one
  rule of plain data.
- K13, K14: `seq` is the storage position, and `Journal` moves into the
  core.
- B2, C1: one factory for each deployment, and no second store in
  Cloudflare.

## Considered and kept

**Each of these looks like a duplicate and carries a meaning of its own.**

- The unions that `rules.verified.ts` declares again. LemmaScript lowers
  only the types of its own file, and `rules.test.ts` pins each copy.
- `startRoom` and `resumeRoom` as public calls. A start writes a
  composition, and a resume keeps the recorded one. They now share one
  transaction.
- `visit.send` and `room.post`. A send has an author, and a post is a
  message of the system.
- `sqlite.ts` and `sqlite-guard.ts`. They are one concept in two files.
- The port suite and the executor suite of the core. Cloudflare runs the
  port suite. The two can share one runner (W4).
- `localExecution`. A host needs one execution of a kind that is not a
  family.
