# Terminology: one word, one meaning

**This page lists the names that break the controlled vocabulary.** The
glossary in [`docs/room.md`](../docs/room.md#glossary) and rule 4 of
`CLAUDE.md` hold the prose. No check holds the identifiers, the `kind`
strings, or the prompt text. Each of those changed on its own.
[Simplification](simplification.md) removes concepts. This page renames
the concepts that stay, so that each word has one meaning.

**The review read the eleven packages, the workbench, and the docs.** It
checks each row against commit `925421e`. It changes no code. Rows that
extend a row of [Simplification](simplification.md) name that row.

**Two rounds of an independent review checked each row and each
proposed name.** The first round found five proposed names that collide
with existing names, and two rows with a wrong premise. It also found
four rows that edit the verified rules or a stored body. The second
round found three new collisions and a check that fails the gate. This
revision holds the findings of both rounds.

## How a row is ranked

**A collision is one word with two meanings, or one meaning with two
words.** A reader must learn each collision as an exception. The rank is
the collisions removed times the confidence. High counts 3, medium
counts 2, and low counts 1.

**The risk column names what else a rename changes.**

| Risk     | What the rename also changes                                                  |
| -------- | ----------------------------------------------------------------------------- |
| Internal | Nothing outside the package                                                   |
| Exports  | The export snapshot and the changelog                                         |
| Journal  | A stored body or key, and the golden journals                                 |
| Rules    | A `rules.verified.ts` file; `pnpm rule:check` and Dafny prove it again        |
| Prompt   | Model-facing text: `prompt-snapshot.test.ts.snap`, the simulator, a live case |

## The four causes

1. **Words from other libraries.** Pi and the vendor SDKs supply words
   that the core keeps. Examples are `tool_execution_start` and
   `toolName` in `ExecutionEvent`, and `turn` in eleven prompt strings.
   The workspace port keeps `cleanup`, `Context`, and `ExecutionEnv`.
2. **A new word at each layer.** One fact takes a new name at each step
   from the wire to the fold to the read. The read position has six
   names: `through`, `readThrough`, `watermark`, `lastSeq`, `since`, and
   `after`.
3. **Overloaded common words.** `host` has five meanings, `harness`
   five, `wake` five, `run` five, `record` six, `pending` four, `view`
   four, `executor` three, and `port` three.
4. **One verb in many forms.** The tool is `say`, the type is
   `SpokenMessage`, the kind is `'said'`, the test verb is `speak()`,
   and the end event carries `spoke`.

## Tier 1: the kernel surface

**These rows fix collisions in the exported names of
`@ambionframework/ambion`.** Each one appears in an application or an
executor package. Paths are relative to `packages/ambion/src` unless a
row names a package.

| ID  | Finding                                                  | Proposal                                                                                                                                                                                             | Evidence                                                                                                                                                               | Removes | Conf.  | Rank | Risk            |
| --- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------ | ---- | --------------- |
| T1  | `executor` names a value, a factory, and a session       | `AgentExecutor` → `Executor`; the factory type → `ActivationOpener`; `ExecutorSession` → `RunningActivation`                                                                                         | `types.ts:551`, `execution/executor.ts:117,160`, `pi/src/executor.ts:1`                                                                                                | 3       | High   | 9    | Exports         |
| T2  | `ExecutionEvent` describes one activation                | `ActivationEvent`; fields `agent`, `author`, `toolName` → `seat`, `seat`, `name`; `tool_execution_*` → `tool_call`, `tool_result`                                                                    | `types.ts:405-438`; `TraceRecord.seat` at `types.ts:524`                                                                                                               | 3       | High   | 9    | Exports         |
| T3  | The purpose of an activation has two sets of values      | `respond` and `summarize` in `ExchangeActivation.purpose`; `isClosing` → `isSummarizing`; one prose name for each purpose                                                                            | `protocol.ts:31`, `types.ts:82`, `room/exchange.ts:275`, `testing/scripted.ts:94`                                                                                      | 2       | High   | 6    | Exports         |
| T4  | Six words name the three stop mechanisms of the room     | `room.abort()` → `room.cancel()`; `AgentRunner.abort()` → `cutAll()`; `ActivationState.cancel()` and `RoomToolBinding.abort()` → `cut()`; the stop reason `'aborted'` → `'cut'`; `room.stop()` stays | `room-host/room.ts:127-129`, `room-host/control.ts:336`, `execution/runner.ts:52,118,133`, `execution/activation.ts:129`, `execution/room-tools.ts:68`, `types.ts:505` | 4       | High   | 12   | Exports         |
| T5  | The verb `say` appears in five forms                     | `SaidMessage`, `isSaid`, test verb `say()`, event field `said`                                                                                                                                       | `types.ts:182,305,423`, `testing/scripted.ts:52`                                                                                                                       | 3       | High   | 9    | Exports         |
| T6  | `DEFAULT_GUIDANCE` is the default of `speaking`          | `DEFAULT_SPEAKING`                                                                                                                                                                                   | `define.ts:61`; `AgentExecutor.guidance` is the bundle guidance                                                                                                        | 1       | High   | 3    | Exports         |
| T7  | `View` names a seat input and a host read                | `ExchangeView` → `Exchange`; `ClosedExchange` (the range) → `ExchangeRange`; `ClosedExchangeView` goes; `readView` → `toRoomRead`                                                                    | `types.ts:38-123`, `protocol.ts:120`, `room/read.ts:29`                                                                                                                | 3       | Medium | 6    | Exports         |
| T8  | `after` is a delay in seconds and a seq cursor           | The delay → `delaySeconds`; a position is `through` (inclusive) or `after` (exclusive)                                                                                                               | `types.ts:32,196`, `define.ts:343`, `protocol.ts:72`, `execution/executor.ts:19`                                                                                       | 2       | High   | 6    | Journal, Prompt |
| T9  | Six names for one read position                          | `watermark`, `lastSeq`, `since` → `through` or `after`; `readThrough` stays                                                                                                                          | `types.ts:134`, `room.ts:163`, `protocol.ts:225`, `room/read.ts:16`                                                                                                    | 3       | Medium | 6    | Exports         |
| T10 | `pending` names a scheduled say and an awaiting exchange | `PendingSay` → `ScheduledSay`; `pendingFor` → `awaitingFor`; test verb `later` → `schedule`                                                                                                          | `scheduling.ts:21`, `room/read.ts:96`, `testing/scripted.ts:56`                                                                                                        | 3       | High   | 9    | Exports         |
| T11 | `event` names a journal entry and a notification         | `journal/events.ts` → `entries.ts`; `applyEvent`, `ProposedEvent`, `acceptedEvent` → `*Entry`                                                                                                        | `room/fold.ts:74`, `room/transition.ts:45`, `room-host/core.ts:155`                                                                                                    | 2       | High   | 6    | Internal        |
| T12 | One stored shape has three names                         | `Entry` for the stored envelope, and `RoomEntry` for the room's union                                                                                                                                | `journal/src/journal.ts:84`, `journal/src/index.ts:31`, `ambion/src/journal/journal.ts:15,55`                                                                          | 2       | High   | 6    | Exports         |
| T13 | `activationId` is the one field that is not `activation` | `Landed.activationId` → `activation`                                                                                                                                                                 | `types.ts:174`                                                                                                                                                         | 1       | High   | 3    | Journal         |
| T14 | `ParticipantInfo` is the one `Info` type of the kernel   | `Participant`, `AgentParticipant`, `HumanParticipant`                                                                                                                                                | `types.ts:356-371`                                                                                                                                                     | 1       | Medium | 2    | Exports         |
| T15 | Outcomes use two discriminators                          | `kind` on `ActivationOutcome`, `SummaryOutcome`, and `ExchangeOutcome`                                                                                                                               | `types.ts:57,64,94`; the summary verdict at `room/rules.verified.ts:582-584`                                                                                           | 1       | Medium | 2    | Exports, Rules  |

**T1 follows the glossary.** The glossary says that a definition is a
name, an identity, and an executor, and `defineAgent({ executor: pi() })`
says the same. The hosting entry names a factory `Executor`, and each
executor package calls its session "the executor". After T1, an
`Executor` is the value in a definition. An `ActivationOpener` takes an
`ExecutorActivation` and returns a `RunningActivation`.
`ActivationState` (`execution/activation.ts:61`) is the core's record of
the same running activation. `RunningActivation` is the executor's half.

**T1 keeps two names.** `ExecutorActivation` stays: it is the half of
one activation that the core gives the executor. The class `Activation`
in each executor package stays: it implements `RunningActivation`. The
word "session" then means the vendor session alone, as O4 names it.
The internal `createPiExecutor()` and its Claude and Codex copies become
`createPiOpener()`, `createClaudeOpener()`, and `createCodexOpener()`.

**T2 leaves `execution` to the host side.** After T2, `Execution`,
`ExecutionHost`, and `defineExecution` share one meaning: the services
that run seats of one executor kind. `tool_call` and `tool_result` are
the names that `Step` already uses.

**T3 keeps the activation source.** `ActivationSource` in
`activation-id.ts:6` names the journal fact that gives an activation its
identity: a `message` entry or a `close` entry. That is a second
dimension, so the id prefixes `message:` and `closed:` stay. The prose
keeps two names: a **respond activation** and a **summary activation**.
"Ordinary", "closing", "response", and "assignment" go from the prose.

**T4 separates three mechanisms.** `room.stop()` ends this run of the
room, and the next run resumes from the record. `room.cancel()` ends the
open work, and the `cancel` entry keeps that fact. A cut ends one
running activation through its port. `AgentRunner` already has the port
method `cut(activation)`, so its method that cuts every activation of
the runner is `cutAll()`. `abort` stays for `AbortSignal`.
The executor docs keep their vendor verbs: Pi aborts, Claude interrupts,
and Codex signals.

**T5 follows the pattern of the other kinds.** `PostedMessage` has the
kind `'posted'`, and `DismissedMessage` has the kind `'dismissed'`. The
`speaking` policy keeps its name, because it describes when an agent
says something.

**T7 answers K17 with five names for five roles.** `ExchangeRef` is the
identity of an exchange, and `ExchangeRange` is the range of a closed
one. `Exchange` is the read model, open or closed. `ExchangeRead` is a
read result with its messages, and `ExchangeHandle` is the live waiter.
`ClosedExchangeView` becomes `Extract<Exchange, { status: 'closed' }>`
at its two call sites. `ClosedExchange` goes as a name, so no name
changes its meaning in one release.

**T8 removes a unit error.** `Intent.after` and the `schedule` tool
count seconds. `Steer.after` and `ReadRange.after` are seqs. The model
sees the tool parameter, so the rename of the parameter is a prompt
change.

**T10 renames the shape that Simplification kept.** The done row "One
shape of a say that waits" removed a second shape, `ScheduledSay`, and
kept `PendingSay`. T10 gives the remaining shape the name that the read
field `scheduled` and the tool `schedule` use. It adds no shape.

## Tier 2: one meaning for each overloaded word

**These rows assign each common word to one concept.** The glossary
gains a row for each word that stays.

| ID  | Word      | Meanings today                                                                                                  | The one meaning that stays                             | Renames                                                                                                                                             | Conf.  | Rank | Risk     |
| --- | --------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- | -------- |
| O1  | `host`    | The embedding application; `RoomHost`; `Workspace.host`; the SSH server; the host loopback                      | The application that embeds a room                     | `Workspace.host` → `mirrorAgent`; `WorkstationOptions.host` → `server`, after S10; `WorkspacePorts.hostname` → `machine`; `RoomHost` stays          | High   | 9    | Exports  |
| O2  | `port`    | An interface boundary (`AgentPort`, W1); a private HTTP endpoint (`WorkspacePort`); the SSH port option         | An interface boundary                                  | `WorkspacePort` → `WorkspaceEndpoint`; `WorkspacePorts` → `WorkspaceEndpoints`; `open` → `forward`                                                  | High   | 6    | Exports  |
| O3  | `wake`    | The `Wake` request; `Message.wakes`; the `wakes.ts` index; a retried unit; a Cloudflare counter                 | The request that the room sends to a seat's port       | `PendingActivation`, `PendingWake`, and the summary "draft" → `DueActivation`; `statusOf` → `dueOf`; `SeatMetadata.wakes` → `wakeCount`             | Medium | 8    | Rules    |
| O4  | `harness` | Pi's `AgentHarness`; `HarnessSession.harness`; the conformance fixtures; `AMBION_HARNESS`; Codex `HARNESS_NOTE` | Pi's `AgentHarness`, and a vendor loop in prose        | `HarnessSession` → `VendorSession { kind, id }`; `Pass.resume` → `resumeId`; `*Harness` fixtures → `*Fixture`; `AMBION_HARNESS` → `AMBION_EXECUTOR` | High   | 12   | Journal  |
| O5  | `family`  | The executor kind in prose (73 uses in the docs and the README); the workbench `Family`; "model family"         | No meaning stays. The word goes.                       | "executor kind" in prose; the workbench `Family` → `ExecutorKind`                                                                                   | High   | 3    | Internal |
| O6  | `agents`  | Every definition (`StartRoomOptions`); the seated agents (`Composition`); definition names (Cloudflare)         | The definitions that an application supplies           | `Composition.agents` → `seated`; `Composition.available` → `reserve`; Cloudflare `agents` → `definitions`                                           | High   | 9    | Journal  |
| O7  | `summary` | The writer's name; the outcome; the message; a `TracePolicy` value                                              | The message and its outcome                            | `StartRoomOptions.summary`, `Composition.summary`, `Close.summary` → `summaryWriter`; `TracePolicy.thinking: 'summary'` → `'start'`                 | High   | 9    | Journal  |
| O8  | `member`  | 62 uses of "member" and "membership" in `docs/`, the glossary row for Seat included                             | No meaning stays. The word goes.                       | "seat", "seated", and "roster"                                                                                                                      | High   | 3    | Internal |
| O9  | `turn`    | Pi's request to a provider; an activation in eleven prompt strings; a Codex run; `FakeScenario.turns`           | Pi's request to a provider                             | Prompts: "end your activation"; the Codex docs map a Codex turn to a pass once; Claude test `turns` → `passes`                                      | High   | 9    | Prompt   |
| O10 | `run`     | One run of a room over its journal; the `run` entry; the simulator `Run`; a Pi run; `RoomTool.run()`            | One run of a room over its journal, as a fence         | The simulator `Run` → `Simulation`; a Pi run is a pass in prose; the body `Fence` and the verb `run()` stay                                         | Medium | 4    | Exports  |
| O11 | `record`  | The messages on the journal; `RoomProjection.record`; `OwedFacts.record`; `TraceRecord`; `AuditLog.record`      | The messages on the journal, as participants read them | `RoomProjection.record`, `OwedFacts.record` → `summaryFacts`; `TraceRecord` → `TracedStep`; `AuditLog.record` → `append`                            | Medium | 8    | Exports  |

**O1 depends on S10.** `server` is the label of `GitBackend` today
(`git-backend.ts:119`). S10 renames that label, so S10 lands first or
in the same commit as O1.

**O1 keeps `RoomHost`.** `RoomHost` is the in-process object that a host
embeds, and it implements `Room` and `RunningRoom`. A new class name
adds a fourth name and collides with "live", which means "on a real
provider" in `test:live` and `test/live/`. The glossary row for Host
names `RoomHost` as the object that the host embeds.

**O2 must land before W1.** W1 says that the workspace owns its port. An
exported `WorkspacePort` that means an HTTP endpoint collides with the
wording of the plan. `WorkspaceEndpoint` fits both backends: the
workstation forwards a remote service, and the just-bash backend serves
the endpoint in process.

**O3 keeps `Wake` for the port request.** `protocol.ts:60` exports
`Wake` as the request that `AgentPort.wake()` carries. The activation
that the room owes a seat becomes a `DueActivation`, after the fold
field `RoomState.due`. Each attempt of a due activation is an activation
with its own id and its own wake. The text "a retry of a wake is a new
attempt" (`types.ts:79`) becomes "a retry is a new attempt of one due
activation". The field `due` on a scheduled say is a time, and a due
activation is a debt of the room. The two share the idea of a time when
work falls due.

**O3 edits the verified rules.** The summary "draft" is in
`room/rules.verified.ts:572-644` as `draftsClose`, `stoodDown`, and
`cancelledDraft`. The rename runs `pnpm rule:check` and Dafny. If K12
merges the wake index and the owed index, O3 lands after K12. `OpenWake`
and `HeldWake` wait for K12.

**O4 changes a stored body.** `HarnessSession` is written to the lease
release body (`journal/events.ts:22`). The name `VendorSession` keeps
"session" for the vendor session, as T1 needs. The glossary gives "Ref"
to a cited URI, so the name has no `Ref` suffix. `AMBION_HARNESS` appears in
`.github/workflows/live.yml`, `CLAUDE.md`, `docs/toolchain.md`, and five
files under `packages/ambion/test`.

**O6 keeps `agents` on the start options.** The glossary calls the set
"the definitions", and `agents: [defineAgent(...)]` is clear. The
stored body is the defect: `Composition.agents` holds the seated agents,
and `available` holds the reserve. The Cloudflare list becomes
`definitions`, because `seats` is the attention map of `startRoom`.

**O7 matches an existing function.** `room/summary.ts:6` exports
`summaryWriter(composition, roster)`. The field and the function have
one meaning, so the shared name is no collision. `'start'` follows the
comment of `TracePolicy`: it keeps the start of each block. The
simulator already uses `brief` for the instructions of its actor.

**O9 is a behavior change.** The assistant package already tells the
model "end your activation". The core prompts in `execution/render.ts`,
`room/transition.ts:243`, and `execution/room-tools.ts:400` say "turn".
The change updates the prompt snapshot, runs the scripted simulator, and
then runs one live case.

**O10 and O11 keep the verbs.** `RoomTool.run()`, `SqlEnv.run()`,
`runScript()`, and `ExecutorActivation.record()` are verbs, and a verb
has no collision with a noun. `PassRecord` stays, because it is the
rendered record of one pass. `Fence` stays, because the glossary row for
Run uses the word, and Pi uses `run_start` in its telemetry.
`TracedStep` holds one `TraceStep` with its room and seat; "line" means
one rendered message in `record.ts`.

## Tier 3: the sibling packages

**These rows align the names of packages that implement one contract.**

| ID  | Finding                                                            | Proposal                                                                                   | Evidence                                                                                               | Conf.  | Rank |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------ | ---- |
| S1  | `ClaudeRuntime` and `CodexRuntime` collide with the core `Runtime` | `ClaudeExecutionOptions`, `CodexExecutionOptions`, as `PiExecutionOptions`                 | `claude/src/options.ts:14`, `codex/src/options.ts:16`                                                  | High   | 6    |
| S2  | Codex declares a `RoomTool` that shadows the core type             | `CodexTool`                                                                                | `codex/src/tools.ts:29`                                                                                | High   | 3    |
| S3  | `Pass.agentTools` holds agent tools under the type `RoomTool`      | A type `AgentTool`, or one list as E6 proposes                                             | `execution/executor.ts:96`; E6                                                                         | Medium | 2    |
| S4  | The testing entry exports a second `Step`, `Call`, and `Result`    | `ScriptStep`, `ScriptCall`, `ScriptResult`; the parameter `call` → `request`               | `testing/scripted.ts:22-44`, `testing.ts:21`                                                           | High   | 6    |
| S5  | Pi `scripted()` collides with the core `scripted()`                | `scriptedStream()`                                                                         | `pi/src/testing.ts`, `ambion/src/testing/scripted.ts:264`                                              | High   | 3    |
| S6  | The workspace object has five names                                | "workspace" for the value, "resource" for the contract; "bash owner" and "shell" go        | `workspace.ts:76,181,416,489`; 44 uses of "bash owner" in `src`                                        | Medium | 6    |
| S7  | The credential lifetime has three option names                     | `credentialTtl`                                                                            | `git-conformance.ts:58`, `just-bash/src/git/backend.ts:78`, `workstation/src/git-backend.ts:55`        | High   | 6    |
| S8  | A process stops under `cancel` in the tool and `stop` in the code  | `cancel` in the code: `process-stop.ts` → `process-cancel.ts`, `StopCause` → `CancelCause` | `process-files.ts:26`, `process-tools.ts:208`, `process-stop.ts`                                       | Medium | 2    |
| S9  | `ProcessStatus` is the whole record, and `.state` is the status    | `ProcessRecord`, with `state`                                                              | `process-files.ts:29,39`                                                                               | Medium | 2    |
| S10 | The storage backend label has four names (extends W8)              | `label`; `WorkspacePorts.hostname` belongs to O1                                           | `git-backend.ts:119`, `object-backend.ts:198`, `sql-backend.ts:170`, `just-bash/src/git/storage.ts:52` | Medium | 4    |
| S11 | Three trace defaults look alike                                    | `DEFAULT_TRACE` → `DEFAULT_TRACE_POLICY`                                                   | `define.ts:35`, `host/runtime.ts:125`                                                                  | Medium | 2    |

**S8 follows the glossary row for Cancel.** A cancel ends work and keeps
the fact: the room writes a `cancel` entry, and a process takes the
state `cancelled`. `stop` then means the end of a room's run alone.

## Considered and kept

**Each of these looks like a collision and carries a meaning of its
own.**

- **The past-tense `Intent` kinds**, such as `said` and `seated`. An
  intent is the message before it lands, so its kinds match the message
  kinds.
- **The activation id prefixes `message:` and `closed:`.** They name the
  source of an activation, which T3 keeps apart from its purpose.
- **`RoomHost`.** O1 gives the reason.
- **The vendor option names**, such as `effort`, `modelReasoningEffort`,
  `cwd`, and `workingDirectory`. They mirror the SDKs, and a reader who
  knows the SDK finds them.
- **The `pi()` and `piExecution()` split.** One is a definition value,
  and the other carries host services.
- **"Pass".** It has one meaning in the core. Each executor doc maps its
  vendor word to it once: a Pi run, a Codex turn, and one Claude result.
- **`kind` as the discriminator of a union.** The glossary row for an
  executor names an **executor kind**, so the bare word stays free.
- **`visit.send` and `room.post`.** A send has an author, and a post is a
  message of the system.
- **The three meanings of "envelope".** D3 of
  [Simplification](simplification.md#the-documentation) holds them.

## The glossary rows to add

**The glossary gains one row for each word that Tier 2 assigns.** The
row for Seat changes too: "An agent's place on the roster, with its
attention."

| Term           | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| Executor       | The value in a definition that names an executor kind and its tools    |
| Executor kind  | The name of an executor implementation, such as `pi`                   |
| Execution      | The services that run the seats of one executor kind                   |
| Pass           | One run of the executor's loop inside one activation                   |
| Due activation | An activation that the room owes a seat; each attempt is an activation |
| Wake           | The request that the room sends to a seat's port for one activation    |
| Cut            | The stop of one running activation through its port                    |
| Cancel         | The stop of work that the record keeps, as an entry or a process state |
| Stop           | The end of one run of a room; the next run resumes from the record     |
| Run            | One run of a room over its journal, which starts with a fence          |
| Host           | The application that embeds a room through a `RoomHost`                |
| Port           | An interface boundary that another process can implement               |
| Through        | An inclusive position on the record                                    |
| After          | An exclusive position on the record                                    |

## A check that holds the vocabulary

**`pnpm check` gains a vocabulary check.** The check is a list of
refused patterns with the paths they apply to. The first entries refuse
the words that phase 1 removes:

- `member` and `membership` in `docs/` (O8).
- `family` in `docs/` and `README.md` (O5).

**A new entry lands with the rename that removes the word.** Each later
entry waits for its row, so the gate passes after each commit.

| Entry                                                  | Lands with |
| ------------------------------------------------------ | ---------- |
| `Spoken` in an identifier                              | T5         |
| `Info` at the end of an exported type name             | T14        |
| `Harness` in an identifier outside `packages/pi`       | O4         |
| `turn` as a whole word in a string literal of `ambion` | O9         |

**The `turn` pattern matches the whole word inside a string literal.**
It skips `return`, and it skips the comment "in turn" at `bundle.ts:50`.
"Turns" in `codex/src/catalog.ts:7` is outside the path of the entry.
Without the check, each change can add new collisions.

## The order of the work

**Phase 1 renames the internal names.** It changes no export, no stored
format, no verified rule, and no prompt.

1. T11, O5, and O8.
2. The vocabulary check, with the entries for phase 1.

**Phase 2 renames the exports.** Each item is one commit that updates
the export snapshot and the changelog.

1. T1 and T2, then T3, T4, T5, T6, T7, T9, T10, T12, and T14.
2. O2, before W1 starts.
3. S10, then O1, O10, O11, and the rest of Tier 3.

**Phase 3 changes the stored formats, the verified rules, and the
prompts.** Each item updates the golden journals, proves the rules
again, or runs the simulator and one live case.

1. T13, O4, O6, and O7 in one commit: the journal bodies and the golden
   journals.
2. O3 and T15: the verified rules, after K12 if K12 lands first.
3. T8: the stored delay and the `schedule` parameter.
4. O9: the prompt text.
