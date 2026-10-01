# Terminology: one word, one meaning

**This page lists the names that break the controlled vocabulary.** The
glossary in [`docs/room.md`](../docs/room.md#glossary) and rule 4 of
`CLAUDE.md` hold the prose. No check holds the identifiers, the `kind`
strings, or the prompt text. Each of those drifted on its own.
[Simplification](simplification.md) removes concepts. This page renames
the concepts that stay, so that each word has one meaning.

**The review read the eleven packages, the workbench, and the docs.** It
checks each row against commit `925421e`. It changes no code. Rows that
extend a row of [Simplification](simplification.md) name that row.

## How a row is ranked

**A collision is one word with two meanings, or one meaning with two
words.** A reader must learn each collision as an exception. The rank is
the collisions removed times the confidence. High counts 3, medium
counts 2, and low counts 1. A row that changes a stored format or a
prompt has a risk column, and the phases below order the work by it.

## The four sources of drift

1. **Borrowed words.** Pi and the vendor SDKs lend their words to the
   core: `tool_execution_start` and `toolName` in `ExecutionEvent`,
   `turn` in eleven prompt strings, and `cleanup`, `Context`, and
   `ExecutionEnv` in the workspace port.
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
executor package.

| ID  | Finding                                                  | Proposal                                                                                           | Evidence                                                                                             | Removes | Conf.  | Rank | Risk            |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------- | ------ | ---- | --------------- |
| T1  | `executor` names a value, a factory, and a session       | `AgentExecutor` → `Executor`; the factory type → `SessionOpener`; `class Activation` → `PiSession` | `types.ts:551`, `execution/executor.ts:160`, `pi/src/executor.ts:1,101` and the Claude, Codex copies | 3       | High   | 9    | Export snapshot |
| T2  | `ExecutionEvent` describes one activation                | `ActivationEvent`; fields `agent`, `author`, `toolName` → `seat`, `seat`, `name`                   | `types.ts:405-438`; `TraceRecord.seat` at `types.ts:524`                                             | 3       | High   | 9    | Export snapshot |
| T3  | The activation purpose has three sets of values          | `respond` and `summarize` in every union; `isClosing` → `isSummarizing`                            | `protocol.ts:31`, `types.ts:82`, `activation-id.ts:6`, `testing/scripted.ts:94`                      | 4       | High   | 12   | Journal, rules  |
| T4  | Six words name the two stop mechanisms                   | `cancel` stops the room; `cut` stops one activation; `abort` stays for `AbortSignal`               | `room-host/room.ts:129`, `control.ts:341`, `runner.ts:52`, `types.ts:505`                            | 4       | High   | 12   | Export snapshot |
| T5  | The verb `say` appears in five forms                     | `SaidMessage`, `isSaid`, test verb `say()`, event field `said`                                     | `types.ts:182,305,423`, `testing/scripted.ts:52`                                                     | 3       | High   | 9    | Export snapshot |
| T6  | `DEFAULT_GUIDANCE` is the default of `speaking`          | `DEFAULT_SPEAKING`                                                                                 | `define.ts:61`; `AgentExecutor.guidance` is the bundle guidance                                      | 1       | High   | 3    | Export snapshot |
| T7  | `View` names a seat input and a host read                | `ExchangeView` → `Exchange`; `ClosedExchangeView` → `ClosedExchange`; the range → `ExchangeRange`  | `types.ts:38-123`, `protocol.ts:120`, `room/read.ts:29` (`readView` returns a `RoomRead`)            | 3       | Medium | 6    | Export snapshot |
| T8  | `after` is a delay in seconds and a seq cursor           | The delay → `delaySeconds`; a position is `through` (inclusive) or `after` (exclusive)             | `types.ts:32,196`, `define.ts:343`, `protocol.ts:72`, `execution/executor.ts:19`                     | 2       | High   | 6    | Journal, prompt |
| T9  | Six names for one read position                          | `watermark`, `lastSeq`, `since` → `through` or `after`                                             | `types.ts:142`, `room.ts:163`, `protocol.ts:225`, `room/read.ts:16`                                  | 4       | Medium | 8    | Export snapshot |
| T10 | `pending` names a scheduled say and an awaiting exchange | `PendingSay` → `ScheduledSay`; `pendingFor` → `awaitingFor`; test verb `later` → `schedule`        | `scheduling.ts:21`, `room/read.ts:96`, `testing/scripted.ts:56`                                      | 3       | High   | 9    | Export snapshot |
| T11 | `event` names a journal entry and a notification         | `journal/events.ts` → `entries.ts`; `applyEvent`, `ProposedEvent`, `acceptedEvent` → `*Entry`      | `room/fold.ts:74`, `room/transition.ts:45`, `room-host/core.ts:155`                                  | 2       | High   | 6    | Internal        |
| T12 | One stored shape has three names                         | One name for the stored envelope: `Entry`, with the room's union as `RoomEntry`                    | `journal/src/journal.ts:84`, `journal/src/index.ts:31`, `ambion/src/journal/journal.ts:15,55`        | 2       | High   | 6    | Export snapshot |
| T13 | `activationId` is the one field that is not `activation` | `Landed.activationId` → `activation`                                                               | `types.ts:174`                                                                                       | 1       | High   | 3    | Journal         |
| T14 | `ParticipantInfo` is the one `Info` type of the kernel   | `Participant`, `AgentParticipant`, `HumanParticipant`                                              | `types.ts:356-371`                                                                                   | 1       | Medium | 2    | Export snapshot |
| T15 | Outcomes use two discriminators                          | `kind` on `ActivationOutcome`, `SummaryOutcome`, and `ExchangeOutcome`                             | `types.ts:57,64,94`                                                                                  | 1       | Medium | 2    | Export snapshot |

**T1 follows the glossary.** The glossary says that a definition is a
name, an identity, and an executor, and `defineAgent({ executor: pi() })`
says the same. The hosting entry gives the word to a factory, and each
executor package calls its session "the executor". After T1, an
`Executor` is the value, a `SessionOpener` opens an `ExecutorSession`,
and `createPiExecutor()` returns a `SessionOpener`.

**T2 frees `execution` for the host side.** After T2, `Execution`,
`ExecutionHost`, and `defineExecution` share one meaning: the services
that run seats of one kind. The event names `tool_execution_start` and
`tool_execution_end` come from Pi. They become `tool_call` and
`tool_result`, as `Step` already names them.

**T3 changes the verified rules.** `rules.verified.ts` declares `Source`
and `GrantPurpose` beside the exported unions, because LemmaScript lowers
only the types of its own file
([Simplification](simplification.md#considered-and-kept)). The rename
edits both copies, the Dafny generation, and the activation id format
`message:` and `closed:`. The prose keeps two names: a **respond
activation** and a **summary activation**. "Ordinary", "closing",
"response", and "assignment" go.

**T4 matches the record.** `room.abort()` writes a `cancel` entry, and
the exchange outcome is `cancelled`. After T4, the room method is
`room.cancel()`, the runner method is `cut()`, and the step stop reason
`'aborted'` is `'cut'`. The executor docs keep their vendor verbs for the
mechanism: Pi aborts, Claude interrupts, and Codex signals.

**T5 follows the pattern of the other kinds.** `PostedMessage` has the
kind `'posted'`, and `DismissedMessage` has the kind `'dismissed'`. The
`speaking` policy keeps its name, because it describes when an agent
says something.

**T7 is a concrete answer to K17.** After T7, `View` names only what a
seat receives: `ActivationView`, the `view` call, and the `view` pass
input. A host reads an `Exchange`, which is open or closed. An
`ExchangeRange` is the range of a closed exchange, as the
`exchange_closed` event carries it. `readView()` becomes `toRoomRead()`.

**T8 removes a unit error.** `Intent.after` and the `schedule` tool
count seconds. `Steer.after` and `ReadRange.after` are seqs. The model
sees the tool parameter, so the rename of the parameter is a prompt
change.

## Tier 2: one meaning for each overloaded word

**These rows assign each common word to one concept.** The glossary
gains a row for each word.

| ID  | Word      | Meanings today                                                                                                  | The one meaning that stays              | Renames                                                                                                                                              | Conf.  | Rank |
| --- | --------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---- |
| O1  | `host`    | The embedding application; `RoomHost`; `Workspace.host`; the SSH server; the host loopback                      | The application that embeds a room      | `RoomHost` and `room-host/` → `LiveRoom` and `live/`; `Workspace.host` → `mirrorAgent`; `WorkstationOptions.host` → `server`; `hostname` → `machine` | High   | 12   |
| O2  | `port`    | An interface boundary (`AgentPort`, W1); a forwarded HTTP endpoint (`WorkspacePort`); the SSH port option       | An interface boundary                   | `WorkspacePort` → `Tunnel`; `WorkspacePorts` → `Tunnels`; `open` → `forward`                                                                         | High   | 6    |
| O3  | `wake`    | The `Wake` call; `Message.wakes`; the `wakes.ts` index; a retried unit; a Cloudflare counter                    | The room's request for an activation    | `PendingActivation`, `PendingWake`, and the summary "draft" → `Wake`, `SummaryWake`; `statusOf` → `wakeOf`; `SeatMetadata.wakes` → `wakeCount`       | Medium | 8    |
| O4  | `harness` | Pi's `AgentHarness`; `HarnessSession.harness`; the conformance fixtures; `AMBION_HARNESS`; Codex `HARNESS_NOTE` | Pi's `AgentHarness`, and a vendor loop  | `HarnessSession` → `SessionRef { kind, id }`; `*Harness` fixtures → `*Fixture`; `AMBION_HARNESS` → `AMBION_EXECUTOR`                                 | High   | 12   |
| O5  | `family`  | The executor kind in prose; the workbench `Family`; "model family" in the simulator                             | Nothing: the word goes                  | `kind` in code and docs; the workbench `Family` → `Kind`                                                                                             | High   | 3    |
| O6  | `agents`  | Every definition (`StartRoomOptions`); the seated agents (`Composition`); names (Cloudflare)                    | The definitions an application supplies | `Composition.agents` → `seated`; `Composition.available` → `reserve`; Cloudflare `agents` (names) → `seats`                                          | High   | 9    |
| O7  | `summary` | The writer's name; the outcome; the message; a `TracePolicy` value                                              | The message and its outcome             | `StartRoomOptions.summary`, `Composition.summary`, `Close.summary` → `summaryWriter` or `writer`                                                     | High   | 6    |
| O8  | `member`  | About twenty uses of "member" and "membership" in the docs for a seat                                           | Nothing: the word goes                  | "seat", "seated", and "roster"                                                                                                                       | High   | 3    |
| O9  | `turn`    | Pi's request to a provider; an activation in eleven prompt strings; a Codex run; `FakeScenario.turns`           | Pi's request to a provider              | Prompts: "end your activation"; Codex docs: "pass"; Claude test `turns` → `passes`                                                                   | High   | 9    |

**O2 must land before W1.** W1 says that the workspace owns its port. An
exported `WorkspacePort` that means a forwarded endpoint then collides
with the wording of the plan.

**O3 makes the current text correct.** "A retry of a wake is a new
attempt" (`types.ts:79`) and "an attempt at a wake or a draft"
(`types.ts:438`) break rule 4 today, because a wake reads as an
activation. With the glossary row "a wake is the room's request for an
activation", each attempt is an activation of one wake, and the text
holds.

**O6 keeps `agents` on the start options.** The glossary calls the set
"the definitions", and `agents: [defineAgent(...)]` reads well. The
stored body is the defect: `Composition.agents` holds the seated agents,
and `available` holds the reserve that the tools and the context call
`reserve`.

**O9 is a behavior change.** The assistant package already tells the
model "end your activation". The core prompts in `execution/render.ts`,
`room/transition.ts:243`, and `execution/room-tools.ts:400` say "turn".
The change runs the scripted simulator first, then one live case, as
`CLAUDE.md` requires for a live run.

## Tier 3: the sibling packages

**These rows align the names of packages that implement one contract.**

| ID  | Finding                                                            | Proposal                                                                                   | Evidence                                                                                        | Conf.  | Rank |
| --- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------ | ---- |
| S1  | `ClaudeRuntime` and `CodexRuntime` collide with the core `Runtime` | `ClaudeExecutionOptions`, `CodexExecutionOptions`, as `PiExecutionOptions`                 | `claude/src/options.ts:14`, `codex/src/options.ts:16`                                           | High   | 6    |
| S2  | Codex declares a `RoomTool` that shadows the core type             | `CodexTool`                                                                                | `codex/src/tools.ts:29`                                                                         | High   | 3    |
| S3  | `Pass.agentTools` holds agent tools under the type `RoomTool`      | A type `AgentTool`, or one list as E6 proposes                                             | `execution/executor.ts:96`; E6                                                                  | Medium | 2    |
| S4  | The testing entry exports a second `Step`, `Call`, and `Result`    | `ScriptStep`, `ScriptCall`, `ScriptResult`; the parameter `call` → `request`               | `testing/scripted.ts:22-44`, `testing.ts:21`                                                    | High   | 6    |
| S5  | Pi `scripted()` collides with the core `scripted()`                | `scriptedStream()`                                                                         | `pi/src/testing.ts`, `ambion/src/testing/scripted.ts:264`                                       | High   | 3    |
| S6  | The workspace object has five names                                | "workspace" for the value, "resource" for the contract; "bash owner" and "shell" go        | `workspace.ts:76,181,416,489`; 44 uses of "bash owner" in `src`                                 | Medium | 6    |
| S7  | The credential lifetime has three option names                     | `credentialTtl`                                                                            | `git-conformance.ts:58`, `just-bash/src/git/backend.ts:78`, `workstation/src/git-backend.ts:52` | High   | 6    |
| S8  | A process stops under `cancel` in the tool and `stop` in the code  | `cancel` in the code: `process-stop.ts` → `process-cancel.ts`, `StopCause` → `CancelCause` | `process-files.ts:26`, `process-stop.ts`                                                        | Medium | 2    |
| S9  | `ProcessStatus` is the whole record, and `.state` is the status    | `ProcessRecord`, with `state`                                                              | `process-files.ts:29,39`                                                                        | Medium | 2    |
| S10 | The backend label has five names (extends W8)                      | `label`                                                                                    | `git-backend.ts:119`, `object-backend.ts:198`, `sql-backend.ts:170`, `backend.ts:63`            | Medium | 4    |
| S11 | Three trace defaults look alike                                    | `DEFAULT_TRACE` → `DEFAULT_TRACE_POLICY`                                                   | `define.ts:35`, `host/runtime.ts:125`                                                           | Medium | 2    |
| S12 | `TraceRecord` uses `record`, which names the room's messages       | `TraceLine`                                                                                | `types.ts:520-534`                                                                              | Medium | 2    |

## Considered and kept

**Each of these looks like a collision and carries a meaning of its
own.**

- **The past-tense `Intent` kinds**, such as `said` and `seated`. An
  intent is the message before it lands, so its kinds match the message
  kinds.
- **The vendor option names**, such as `effort`, `modelReasoningEffort`,
  `cwd`, and `workingDirectory`. They mirror the SDKs, and a reader who
  knows the SDK finds them.
- **The `pi()` and `piExecution()` split.** One is a definition value,
  and the other carries host services.
- **"Pass".** It has one meaning in the core. Each executor doc maps its
  vendor word to it once: a Pi run, a Codex turn, and one Claude result.
- **`visit.send` and `room.post`.** A send has an author, and a post is a
  message of the system.
- **The three meanings of "envelope".** D3 of
  [Simplification](simplification.md#the-documentation) holds them.

## The glossary rows to add

**The glossary gains one row for each word that Tier 2 assigns.**

| Term      | Meaning                                                   |
| --------- | --------------------------------------------------------- |
| Executor  | The value in a definition that names a kind and its tools |
| Execution | The services that run the seats of one executor kind      |
| Kind      | The name of an executor implementation, such as `pi`      |
| Pass      | One run of the executor's loop inside one activation      |
| Wake      | The room's request for an activation of one seat          |
| Cut       | The stop of one running activation through its port       |
| Cancel    | The durable stop of the room's work, written as an entry  |
| Host      | The application that embeds a room                        |
| Port      | An interface boundary that another process can implement  |
| Through   | An inclusive position on the record                       |
| After     | An exclusive position on the record                       |

## A check that holds the vocabulary

**`pnpm check` gains a vocabulary check.** The check is a list of
refused patterns with the paths they apply to. The first entries:

- `turn` in a string literal under `packages/ambion/src`.
- `Spoken`, `Harness` outside `packages/pi`, and `Info` at the end of an
  exported type name.
- `member` and `membership` in `docs/`.

Without the check, each tier drifts back. The check runs in the gate,
and a new entry goes in with the rename that needs it.

## The order of the work

**Phase 1 renames the internal names.** It changes no export, no stored
format, and no prompt.

1. T11, and the internal half of O3.
2. O1 for `RoomHost` and `room-host/`.

**Phase 2 renames the exports.** Each item is one commit that updates
the export snapshot and the changelog.

1. T1 and T2, then T5, T6, T7, T9, T10, T12, T14, and T15.
2. O2, before W1 starts.
3. O4, O5, and Tier 3.

**Phase 3 changes the stored formats and the prompts.** Each item
updates the golden journals, or runs the simulator and one live case.

1. T3, T13, O6, and O7 in one commit: the journal bodies, the activation
   id, and the verified rules.
2. T4 and T8: the room method, the stop reason, and the `schedule`
   parameter.
3. O9: the prompt text.

**The vocabulary check lands with phase 1.** Each later commit adds the
entries for its own renames.
