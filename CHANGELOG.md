# Changelog

## Unreleased

**A conformance fixture is a fixture, and the testing entry names its own
script types.** `@ambionframework/ambion/conformance` exports
`ExecutorFixture` and `PortFixture` in place of `ExecutorHarness` and
`PortHarness`. `ConformanceHarness` is now `ConformanceFixture` in
`@ambionframework/journal/conformance`, and in the entries that re-export
it. `@ambionframework/pi/testing` exports `piExecutorFixture`.
`@ambionframework/claude/testing` exports `claudeExecutorFixture` and
`ClaudeFixtureOptions`. `@ambionframework/ambion/testing` exports
`ScriptStep`, `ScriptCall`, and `ScriptResult` in place of `Step`, `Call`,
and `Result`, so `Step` names the trace step alone. The request counter of a
script is now `request`. The live tier reads `AMBION_EXECUTOR` in place of
`AMBION_HARNESS`.
**Three types, one method, and two fields change name.**
`@ambionframework/simulator` exports `Simulation` and `SimulationExchange`
in place of `Run` and `RunExchange`. A run now means one run of a room over
its journal. `@ambionframework/ambion` exports `TracedStep` in place of
`TraceRecord`, and the parameter of `TraceLogger` is `traced`.
`AuditLog.record` of `@ambionframework/workspace` is `append`, the name that
`WorkspaceLog.append` has for the same act. `RoomProjection.record` and
`OwedFacts.record` are `summaryFacts`, because a record is the messages
that participants read. The internal constant `DEFAULT_TRACE` is
`DEFAULT_TRACE_POLICY`. No journal body changes.
**A say that waits is a `ScheduledSay`, and `awaitingFor` lists the waits on a
person.** `PendingSay` is now `ScheduledSay`. `pendingFor(read, person)` is
now `awaitingFor(read, person)`. The testing verb `later` is now `schedule`.
The read field `scheduled` and the tool `schedule` already used the new name.
This renames the one remaining shape and adds no shape. The journal and the
golden journals do not change.

**`View` names only what a seat receives, and a read position is `through`
or `after`.** `ExchangeView` is now `Exchange`. `ClosedExchange`, the range
that the `exchange_closed` event carries, is now `ExchangeRange`.
`ClosedExchangeView` is gone from the main entry. Write
`Extract<Exchange, { readonly status: 'closed' }>` in its place.
`RoomRead.watermark` and `ExchangeRead.watermark` are now `through`. The
`ok` of a `LeaseResponse` holds `through` where it held `lastSeq`. The
selection `read({ messages: { since } })` is now `{ after }`, and the delta
of a `PassInput` holds `after` where it held `since`. The wire carries the
new names. The journal and the golden journals do not change.
**Outcomes use one discriminator, `kind`, and `wake` names only the port
request.** `ActivationOutcome` and `SummaryOutcome` switch from `status` to
`kind`, as `ExchangeOutcome` already uses it. The `status` field stays on the
exchange read model. The room calls the activation that it owes a seat a due
activation, after `RoomState.due`. In the core, `PendingActivation` becomes
`DueActivation`, `PendingWake` becomes `DueWake`, and `statusOf` becomes
`dueOf`. The verified rules rename the summary sense of "draft" to "summary":
`draftsClose` becomes `summarizesClose`. In the Cloudflare package,
`SeatMetadata.wakes` and `SeatObject.wakes()` become `wakeCount`. No journal
body changes.
**`ExecutionEvent` is now `ActivationEvent`.** Every member of the type
describes one activation. The main entry and the hosting entry export the
new name, and `RoomNotification` is `RoomEvent | ActivationEvent`. Each
member names its seat in `seat`, where the members said `agent` and the
`conflict` member said `author`. The tool members use `name` in place of
`toolName`. The member types `tool_execution_start` and `tool_execution_end`
are now `tool_call` and `tool_result`, the names that `Step` uses. The
`spoke` field of `activation_end` is now `said`. The Cloudflare `SeatEvent`
log line carries the new member types in its `event` field.
**The verb `say` names the message type, its guard, the test verb, and the
speaking default.** `SpokenMessage` is now `SaidMessage`, which follows the
kind `'said'` as `PostedMessage` follows `'posted'`. `isSpoken` is now
`isSaid`. The test verb `speak` of `@ambionframework/ambion/testing` is now
`say`. `DEFAULT_GUIDANCE` is now `DEFAULT_SPEAKING`, the default of
`AgentExecutor.speaking`. `AgentExecutor.guidance` keeps its name. The
callback `RoomToolOptions.spoke` is now `said`. The kind string, the
journal bodies, and the text that a model reads do not change.
**Three names in the process and credential options change.** The option
`tokenTtl` of `justGitBackend` and the option `keyTtl` of
`workstationGitBackend` are now `credentialTtl`, the name that
`GitConformanceOptions` already used. The exported type `ProcessStatus` is
now `ProcessRecord`. A tool call or the host that ends a process cancels
it, and the code now says so: `process-stop.ts` is `process-cancel.ts`, and
`ProcessTable.cancel` gives `cancelled` where it gave `stopped`. The `stop`
file in the directory of a process keeps its name. The tool names and the
text for the model do not change.
**The workspace packages name an endpoint, a label, and a server.** The word
`host` now names the application that embeds a room, and the word `port`
names an interface boundary. `WorkspacePort` becomes `WorkspaceEndpoint`.
`WorkspacePorts` becomes `WorkspaceEndpoints`. Its method `open` becomes
`forward`, and its field `hostname` becomes `machine`. The field `ports` of
`BashBackend` becomes `endpoints`. `GitBackend.server`,
`ObjectBackend.store`, and `SqlBackend.database` become `label`.
`Workspace.host` becomes `Workspace.mirrorAgent`. The agent name
`<name>-host` stays. `WorkstationOptions.host` and
`WorkstationGitOptions.host` become `server`.
**The executor options and the Pi test stream get their own names.**
`@ambionframework/claude` exports `ClaudeExecutionOptions`, and
`@ambionframework/codex` exports `CodexExecutionOptions`. They replace
`ClaudeRuntime` and `CodexRuntime`, and they match `PiExecutionOptions`.
The word `Runtime` now names the core `Runtime` alone.
`@ambionframework/pi/testing` exports `scriptedStream` in place of
`scripted`. The core testing entry keeps `scripted`, the scripted
execution. The Codex tool that the stdio server lists is `CodexTool`. It
replaces a `RoomTool` that shadowed the core type of the same name.

**Breaking: the seat text of a Codex seat leaves the first user message.**
The Codex SDK has no system prompt option, so the executor put the harness
note, the mechanism, and the agent instructions in front of the view in the
first user message, under the base prompt of Codex, about 18 KB. The executor now
passes that text in the config of the client, fixed for the activation. The
first user message holds the view alone. A seat with `nativeTools: 'none'`
gets the text in a file in the scratch directory, named by
`model_instructions_file`. The file replaces the base prompt of Codex, so the
first developer message is the seat text and no message starts with "You are
Codex". A seat with `nativeTools: 'codex'` gets the text as
`developer_instructions` after the base prompt, which teaches its native
tools.

**A resumed `codex` thread keeps its developer message.** Codex 0.158.0
keeps the `developer_instructions` that a thread started with, and ignores a
new value on resume. The seat text depends on the purpose of the activation.
The first prompt of a `nativeTools: 'codex'` activation that resumes a thread
therefore carries the seat text, then the view. A fresh thread and every
`nativeTools: 'none'` activation send the view alone. A resumed `'none'`
activation uses its own instructions file.

**`Pass.agentTools` is gone.** `Pass.tools` holds the room tools that the
purpose grants, then the tools of the definition. A closing activation gets
the room tools alone. Claude and Codex joined the two lists at once, and
they now host `pass.tools`. Pi hosts the room tools from `pass.tools`, the
tools that the definition does not name, and builds the tools of the
definition from their `AmbionTool`s as before.

**Breaking: a Codex seat no longer reads `~/.codex`.** The executor never
set `CODEX_HOME`, so every seat ran in the Codex home of the host user. The
`[mcp_servers.*]` of its `config.toml` started on every pass beside the room
tools server, its `model_provider` rerouted the model traffic of the seat,
and its `AGENTS.md` joined every request. `codexExecution()` now gives its
seats a Codex home of their own and sets `CODEX_HOME` to it, for each run of
the binary and for the `codex debug models` run of the catalog. The default
is `.ambion/codex` under the `HOME` of `env`, with the mode `0700`, and the
new option `home` names another. The new option `login` names the `auth.json` to link into the
home. The default is the login file of the host, and `false` links nothing.

**The seat home links the login of the host and never copies it.** A seat
on a ChatGPT sign-in keeps working with no extra step. The first activation
makes a symbolic link `auth.json` in the home, or a hard link where symbolic
links fail. Codex writes the file in place and reads it again before it
refreshes a token, so the host and the seats share one login. A home that
holds its own `auth.json` keeps it. If no link can be made, the activation
fails as permanent.

**Three changes need action.**

- A thread that an earlier version started lives in `~/.codex/sessions`.
  Threads now live in `sessions` in the seat home, so such a thread starts
  fresh.
- A login in the OS keyring cannot be shared, because Codex keys it by a hash
  of the `CODEX_HOME` path. Set `cli_auth_credentials_store = "file"` and run
  `codex login` again, or run `CODEX_HOME=~/.ambion/codex codex login`.
- The `CODEX_HOME` of `env` now names the Codex home of the host, and only
  sets the default `login`. The binary never gets it. Pass `home` to place the
  seat home.

**The binary tier proves the isolation and the link.** The host home of
`test/binary.ts` holds a `config.toml` that reroutes the provider and starts
an MCP server, and an `AGENTS.md` with a marker. A test asserts that none of
them reaches a seat. Another test runs a provider on the linked login, with a
proxy that refuses every outbound connection.

**The Codex package tests the real `codex` binary on a scripted model.**
`codex` accepts a custom model provider through its config. A local endpoint
in `packages/codex/test/responses.ts` speaks the Responses API and plays a
script of replies. `test/binary.test.ts` runs the bundled binary against it,
in a temporary Codex home, with a minimal environment. It proves that a seat
speaks through `say`, that the activation reports the usage of the endpoint,
that the model sees the room tools, the tools of the seat, and the three
MCP resource tools and no native tool, and that a second pass resumes the
same thread. This tier runs in the unit tier and needs no key. The executor
does not change.

**`addUsage` joins the main entry.** `@ambionframework/ambion` exports
`addUsage(total, step)`, which adds a step to a total, which may be absent.
The core already held this function. The Pi executor held a second copy as
`sum`. The simulator held a third as `total`. Both now call `addUsage`.

**The main entry exports `ToolContent` and `contentText`.** `ToolContent` is
one part of what a tool hands back to the model, and `ToolResult.content`
holds a list of them. `contentText(content)` joins the text parts of such a
list. `ToolContent` replaces `RoomToolContent`, which the hosting entry
exported. The hosting entry no longer exports it. The content union was
written in `bundle.ts`, in `room-tools.ts`, and in `wire.ts` of the Codex
package. The text join was written in the core test language, twice in the
Pi executor, and twice in the workspace.

**The hosting entry holds the helpers that executor families shared.**
`@ambionframework/ambion/hosting` adds `present`, `pickPresent`, and
`ROOM_SERVER`. The Claude and Codex packages each held a copy of
`ROOM_SERVER`. They each held a copy of `present`. They each held a copy of
the policy pick, which `pickPresent` replaces.

**`@ambionframework/workspace/git` exports `DEFAULT_BRANCH` and
`BACKEND_AUTHOR`.** The just-bash and workstation backends import them.
Each backend wrote its own copy before.

**`hostingOf` returns the state of the runtime.** `hostingOf(runtime)`
returns the runtime's own state, as an `ExecutionHost` that also holds
`journals`, `executions`, and `evict`. Before, it built a copy with
`journals`, `executions`, `limits`, and `evict`. The value now also holds
`clock`, `storage`, and `logger`, so a host passes `hostingOf(runtime)` to
`Execution.connector`. Nothing else in the public surface changes.

**The journal reads only the format this release writes.**
A journal that an earlier release wrote is not supported, and the journal
adds no reader for it. Two promises of `docs/durability.md` go, and a host
with an older journal sees no error from either:

- **The body schemas no longer refuse the fields of earlier releases.**
  `said.owner`, `close.owner`, `close.cancelled`, `run.format`, and
  `cancel.close` met the refusal `expected no such field; an earlier
  release wrote it`. A body schema now accepts them as any extra field.
  The room does not read `close.owner`, `run.format`, or `cancel.close`. A
  `said` entry keeps `owner` as an extra field of its message. A `close`
  entry with `cancelled: true` reads as a cancelled close, because the
  fold takes a `close` body as written.
- **The journal no longer promises to read a key with no prefix from an
  older journal.** A delivery key starts with `delivery:`, a commit key
  with `commit:`, and a post key with `post:`. A presence key and a cancel
  key carry no prefix, and the room reads them as written.

A stored entry with no `run` stays readable. A journal that opens with no
run reads and writes such entries.

**The audit log names its threshold `rotateBytes`.**
`AuditLogOptions.maxBytes` and `AuditLog.maxBytes` of
`@ambionframework/workspace` are now `rotateBytes`, the name that
`openLog` and the room mirror use. The default stays 5 MiB. The refusal of
a threshold that is not positive and finite now starts with `rotateBytes`.
Before, it started with `maxBytes`. A host that sets `audit: { maxBytes }`
sets `audit: { rotateBytes }`.

**One formatter writes the sizes in refusals and guidance.**
A size prints in the largest unit that fits: GiB, MiB, or KiB. It prints
whole when the unit divides it evenly, and with one decimal otherwise. A
value that rounds to 1024 of a unit prints in the next unit, so 1 MiB
less 1 byte reads `1.0 MiB`. A size below 1 KiB prints in bytes. The
import refusal of a file reads `40 MiB` where it read `40.0 MiB`, and it
names a size from 1 KiB to 1 MiB in KiB where it named bytes. The audit
guidance names a threshold in the same way. Before, it named bytes for a
threshold that was not a whole KiB, and MiB for 1 GiB and above, so
10,000,000 bytes now reads `9.5 MiB` where it read `10000000 bytes`, and
1 GiB reads `1 GiB` where it read `1024 MiB`. The guidance for the default
5 MiB and the SQL guidance of 32 MiB do not change.

**The object-size refusal names the limit once.**
The refusal of an object over 5 GiB now reads `/big holds 5.0 GiB, more
than the 5 GiB that an object holds.` Before, it read `/big holds 5.0 GiB,
and an object holds at most 5.0 GiB.`

**`@ambionframework/workspace` exports `MAX_TIMER_SECONDS`.**
The constant is 2,147,483, the most seconds that a Node timer holds. The
bash timeout, the SQLite timeout, the process table, and the workstation
checks of `idleTimeout`, `timeout`, and `grace` read this one value. No
limit changes, and no message changes.

**Pi runs on a Claude or a ChatGPT subscription.**
`@ambionframework/pi` exports `fileCredentials`, `loginPi`, and
`terminalInteraction`, and `piExecution` and `createExecutionServices` take
a `credentials` option: a Pi `CredentialStore`. `loginPi('anthropic', store)`
signs in with a Claude Pro or Max account, and `loginPi('openai-codex',
store)` signs in with a ChatGPT Plus or Pro account. `fileCredentials(path)`
keeps the sign-ins in one file of mode `0600`, and writes each refresh
through a lock file and a rename, so no seat loses a rotated refresh token. Each lock names its owner, and
a process removes only its own lock.
A provider with a stored sign-in no longer reads its `<PROVIDER>_API_KEY`.
A host with no `credentials` reads the environment, as before. The shared
classifier now reads `invalid_grant` and `provider is not configured` as
permanent. The Claude and Codex guides state how to run those seats on a
subscription: `claude login` or `CLAUDE_CODE_OAUTH_TOKEN`, and `codex
login`. Neither package changes.

**One scripted test language serves the core and Pi.**
`@ambionframework/ambion/testing` renames the type `Turn` to `Reply`,
because `turn` means one request to a provider in Pi. `seat(name)` joins the verbs `callTool`,
`speak`, `later`, `spend`, and `quiet` in that entry. `byAgent` is generic:
`byAgent<Input, Out>` routes a script that reads a `Step` and a script that
reads a Pi `Context` with one function. `@ambionframework/pi/testing` drops
`callTool`, `speak`, `later`, `quiet`, `seat`, and `byAgent`. A Pi script
reads these verbs from the core entry. The Pi type `Script` is now
`PiScript`, and a `PiScript` answers with a `Reply` or an
`AssistantMessage`. `isClosing` in the Pi entry is now `isClosingContext`,
so the name `isClosing` means only the view check of the core. The Pi
`scripted` stream turns a reply into a message: one tool call for each call,
or a text that ends the run for an empty reply. It turns a `spend` reply
into an error message. `quiet` takes no text. A test that reads the text
builds the message with `fauxAssistantMessage`.

**The hosting entry exports what a host or an executor family uses.**
`@ambionframework/ambion/hosting` no longer exports 28 names. No package,
test, or example outside the core imported them, and no page told a reader
to use them. These 17 values leave: `DEFAULT_TRACE`, `DEFAULT_TRACE_LIMITS`,
`SAY`, `SEAT`, `UNSEAT`, `DISMISS`, `SCHEDULE`, `RECALL`,
`PERMANENT_STATUS`, `REMINDER_TIMEOUT_MS`, `callLimits`, `refusal`,
`renderLine`, `summaryToolDescription`, `assertWire`, `roundTrip`, and
`classifyCommit`. These 11 types leave: `Hosting`, `Limits`,
`ExecutionConnector`, `Clock`, `EndReason`, `RoomToolResult`,
`ActivationPurpose`, `CollaborationContext`, `ContextParticipant`,
`CommitOutcome`, and `Stale`. The core keeps each symbol that it still uses
internally. `Clock` stays in the main entry. `PERMANENT_STATUS` and
`callLimits` have no other user, so their
modules no longer export them. `hostingOf` still returns the same value. A
host reads its fields without a name for its type.

**`ExecutionServices` holds what the executor reads.**
`@ambionframework/pi` exports `ExecutionServices` with `stream`, `model`,
and `sessions`. The `clock`, `call`, and `trace` fields are gone, because
no code read them. The executor takes its clock from the host.
`createExecutionServices` takes `PiExecutionOptions`: `stream`, `sessions`,
`sessionDir`, and `credentials`. The `clock`, `call`, and `trace` options are gone.
`PiExecutionOptions` is the one option type of the Pi execution and its
services. `ExecutionServicesOptions` and `SessionPlace` leave the entry of
`@ambionframework/pi`.

**`Executor` is a function of the activation.**
`@ambionframework/ambion/hosting` exports `Executor` as
`(activation: ExecutorActivation) => ExecutorSession`. Before, it was an
object with an `open` method and an optional `harness` string. The
`harness` field is gone. The core records the session of a seat, and
resumes it, under the executor kind of the seat: `definition.executor.kind`.
Every shipped family served one kind and set `harness` to that kind, so the
recorded sessions do not change. The scripted executor, `speakOnce`, the
executor of a seat with no execution, and the workbench `unavailable`
report no session, so a release records none and no pass gets a `resume`.
`createPiExecutor` and `PiExecutorOptions` leave the entry of
`@ambionframework/pi`. `createClaudeExecutor` and `ClaudeExecutorOptions`
leave the entry of `@ambionframework/claude`. `createCodexExecutor` and
`CodexExecutorOptions` leave the entry of `@ambionframework/codex`. Use
`piExecution`, `claudeExecution`, and `codexExecution`.

**One rule turns a thrown error into a failed pass.**
`@ambionframework/ambion/hosting` exports `PermanentError` and `failedPass`.
`PermanentError` names an executor fault that a retry cannot clear, because
the retry runs the same configuration. `failedPass(thrown)` gives the failed
`PassResult` of a thrown value: the cause is `permanent` for a
`PermanentError` and `transient` for every other value, and `error` is
always set. The rule reads the name of the error, so a second copy of the
package gives the same cause. The core, the scripted executor, and the Pi,
Claude, and Codex executors call it. Before, each of the six wrote the
conversion. The Pi executor and the Codex catalog
throw `PermanentError`. The internal `UnknownModel` of Pi and the internal
`PermanentError` of Codex are gone. A Claude pass that throws
`PermanentError` now fails as permanent. A Codex pass that throws a value
that is no `Error` now carries an `error` in its result.

**The core records every `steer` step.** `ActivationState` records the
`steer` step of each steered line, with one rule for every family. A line
that lands between passes is `consumed: false`. A line that the view of the
pass in flight holds is `consumed: true`. A line that lands in a pass whose
executor has no `steer` is `consumed: false`. A line that the executor
delivers is `consumed: true` when the executor calls `read` for its range,
`{ after, through: seq }`, and `consumed: false` when the pass ends first.
A `steer` that throws leaves the line `consumed: false`. A line that lands
before the first pass waits for that pass, and then follows the same rule.
When no first pass runs, because of a cut, a view of another seat, or a
failed claim, the line is `consumed: false`, and its step comes before the
`end` step. `ActivationState` has a new public method, `dropEarly`, and the
runner calls it.

The executor records no `steer` step. The `steer` member of
`ExecutorSession` only delivers the line. The core calls it at any moment
after it calls `pass` and before that pass settles, also before the body of
`pass` reaches its first `await`. The executor holds a line that its harness
cannot take yet, delivers it when the harness can, and drops what it holds
when `pass` settles. The Pi and Claude executors lose their own stamps.
The Claude executor now holds a line from the start of a pass until the
pass sends its prompt, on every pass.

Four steps change. A Codex seat and a scripted seat now record a `steer`
step with `consumed: false`. Before, they recorded none. A Pi line that
lands before the first pass is now `consumed: true` when the first view
holds it, as a Claude line was before. A Pi line past the first view now
joins the first prompt, and it is `consumed: true` when the first request
holds it. Before, Pi dropped it with `consumed: false`. A Claude steer that
finds no echo when its pass ends now records `consumed: false`. Before, it
recorded no step. The conformance case `holds a steer for the record when
the executor cannot steer` now requires a `steer` step with
`consumed: false` for the line.

**`HomeEnv` implements the file members of `ExecutionEnv`.**
`@ambionframework/workspace` exports two new types: `FileOperations` and
`FileExpect`. `FileOperations` holds one throwing storage operation for each
file member. `FileExpect` is `'file' | 'directory' | 'any'`: what a failed
call expected at the path. A backend that extends `HomeEnv` now supplies two
abstract members: `files`, a `FileOperations`, and `classify`, which turns
what an operation threw into a `FileError`. `HomeEnv` resolves the path,
checks the abort signal, runs the operation, and classifies a throw. Before,
each backend wrote that skeleton for every member. `readTextFile` is no
longer abstract. `BashEnv` and `SshEnv` now supply operations and a
classifier, and `SshEnv` overrides `renameFile` alone. No behaviour
changes.

**`bash` takes a `grace` for each call.** The new optional parameter `grace`
is a number of seconds from 1 to 300, 10 by default. A value outside the
range fails the call with `Invalid`. The table writes `grace` to `spec`,
so an adopted process keeps the grace of its own call. A `spec` with no
`grace` is no spec: a read skips it. `ProcessStatus` gains
`grace: number`. `cancel` and `workspace.processes.cancel` wait for the end up to the grace, at most 10
seconds, and 5 seconds more: 15 seconds at most. When the wait ends first,
they give the status `running` with `stopping: true`, and the stop goes on.
No stop holds the chain of its agent while it waits for the grace, so a
later cancel or timeout of the agent does not wait for it. `dispose()` still
waits for the full grace and 5 seconds of each process. The message of the
workbench for a cancel that did not end now reads `did not end within the
wait of the stop.` The workstation backend sends one signal channel at a
time for each SSH client, so overlapping stops stay inside the 10 sessions
of OpenSSH. No journal body changes.

**`dispose()` stops the processes of one agent at the same time.** Before,
an agent with 4 processes that ignore `SIGTERM` took about 60 seconds to
stop. Now the processes of this run stop in about one grace and 5 seconds.
An adopted process takes one chain step for each signal, and waits for the
end outside the chain.

**One function holds the decisions of repository registration.**
`@ambionframework/workspace/git` exports two new names:
`registerRepositories(steps, { templates, shared })` and the type
`RegistrationSteps`. The function registers the templates, then the shared
repositories, each in name order. It checks each name and each source path,
chooses create, update, or no write, and reads each repository after a
write. A backend supplies five storage steps: `template`, `createTemplate`,
`updateTemplate`, `shared`, and `seedShared`. `justGitBackend` and
`workstationGitBackend` now implement only those steps. Two behaviours of
`justGitBackend` change. It now refuses a source path with an empty part,
`.`, `..`, or `.git`, as `workstationGitBackend` did. Before, it stored such
a path in the tree. It also reads each repository after its registration
writes it, so a repository that did not land fails with its name. When an
update step throws, the function reads the tip again. If the tip holds the
source, another host process landed the same files, and the registration
succeeds. Otherwise the function throws the error of the step. The
refusal of a moved `main` in `workstationGitBackend` now reads
`The template '<name>' did not move to its new source: git update-ref failed:
<message>`. It is the same text as in `justGitBackend`, with the git message
after it. The path error of a shared repository now reads
`The shared repository '<name>' holds the path ...`.

**A stop gives a process time to clean up.** `cancel`, the timeout, a
cancel by the host, and `dispose()` now send `SIGTERM` to the process
group, wait a grace of 10 seconds, and then send `SIGKILL`. Before, a
stop sent `SIGKILL` at once. The wrapper of a process installs
`trap : TERM`, so it writes `exit` when the command ends inside the grace.
A command that traps `TERM` and exits 0 reads `exited` with code 0 after
a cancel or a timeout. A command that the `SIGTERM` ends, with code 143,
reads the cause of the stop. `cancel` waits up to 15 seconds, the grace
and 5 seconds. On just-bash a stop still ends the command at once.
`@ambionframework/workspace` exports the type `WorkspaceExecOptions`: the
exec options with a `grace` in seconds. `WorkspaceEnv.exec` takes it. The
workstation sends the two signals for an abort with a grace, and refuses
a grace outside 0 to 2,147,483 seconds. `ProcessStatus` gains `stopping`,
which is `true` while a process that the table stopped still runs. The
workstation's command script adds `trap : TERM`. A channel that a signal
ends now reports 128 plus the signal number: before, `ssh2`'s `SIG`
prefix gave 128. No journal body changes.

**One harness type, one `check`, and one case runner serve the conformance
suites.** `@ambionframework/journal/conformance` exports three new parts:
`check(condition, what)`, `ConformanceHarness<Subject>`, and
`conformanceSuite(harness, cases)`. `ConformanceHarness<Subject>` has a
`name` and an `open()` that returns the subject. `conformanceSuite` opens the
subject for each case, runs the body, and disposes the subject after it.
`@ambionframework/ambion/conformance` and
`@ambionframework/workspace/conformance` export the same three. The harness
type replaces four names, and each suite keeps its subject type:
`StorageBackend` is now `ConformanceHarness<OpenedBackend>`,
`ConformanceBackend` is now `ConformanceHarness<WorkspaceConformanceStore>`,
`ObjectConformanceBackend` is now `ConformanceHarness<ObjectConformanceStore>`,
and `SensorConformanceHarness` is now
`ConformanceHarness<SensorConformanceProbe>`. A storage harness now needs a
`name`, as the three other harnesses had. `@ambionframework/workspace/conformance`
also exports `WorkspaceConformanceStore`, the subject of
`workspaceConformance`. `GitConformanceBackend` extends
`ConformanceHarness<GitConformanceStore>`. The case names and messages do not
change.

**One rule records every tool call.** `workspaceTools` passes each tool of
the bundle through one function, `audited`, when the workspace has an audit
log. The entry is one more operation on the bash owner after the call ends.
Another operation can run between the call and its entry. The file tools
`read`, `write`, and `edit` now follow this rule. Before, their entry ran
inside the operation of the call. A call with invalid arguments now has an
entry, as `docs/workspace.md` states. A call that ends after `dispose`
starts has no entry, because the bash owner refuses the record. The `onError`
of the audit log, now also a field of `AuditLog`, receives an error that
names the tool and the call id. The tool factories drop their `audit`
option. No journal body changes.

**One shape holds each workspace capability.** `workspaceTools` builds the
bundle from six capabilities in a fixed order: the file tools, the
processes, the snapshots, `sql`, git, and the sensors. Each capability gives
its tools, its guidance notes, and its reminder. The bundle merges the
reminders, and `withSkills` uses the same merge. The tool line of the
guidance reads the names of the tools, so it no longer keeps name lists. The
text the model reads does not change. No export changes.

**An executor family is one call.** `defineExecution(kind, build)` in
`@ambionframework/ambion/hosting` now returns the function that gives an
execution for a set of options, and it registers the execution with no
options as the default of the kind. `build` takes the host and the
options. `piExecution`, `claudeExecution`, and `codexExecution` are the
results of that call, with unchanged signatures. `localExecution` stays for an execution that is not a
family. `@ambionframework/claude` drops the `ClaudeExecutionOptions` alias
and `@ambionframework/codex` drops `CodexExecutionOptions`; use
`ClaudeRuntime` and `CodexRuntime`.

**A room read is the one read of pending says and waits.** `Room` drops
`pendingFor(person)` and `scheduled()`, and the Cloudflare `RoomObject`
drops `scheduledSays()`. Read `scheduled` from `room.read()`, and call
`pendingFor(read, person)` on the read. Journal bodies and stored formats do
not change.

**Git backends support shared repositories.** Both `justGitBackend` and
`workstationGitBackend` accept `shared` registrations. Every workspace
agent can push to `shared/<name>`; templates stay read-only and agent forks
keep their owner. Registration seeds `main` once as `ambion`, then updates
only the description without reading the source. Removing a registration
preserves the repository and its push rights. Shared default branches
refuse deletion and non-fast-forward pushes; other branches remain mutable.
The git tools remain `repos`, `clone`, and `fork`, with updated guidance.
`gitConformance` covers shared repositories; its fixture options add
`shared` and the conformance entry exports `GitConformanceShared`.

**The git registration type is renamed.** The workspace git entry replaces
`TemplateRegistration` with `RepositoryRegistration`, exports `SHARED` and
`writableBy`, and reserves `shared` as an agent name. There is no alias or
migration. Journal bodies and stored schemas do not change.

**The 0.5.0 sensor work keeps the eleven-package workspace.** It adds no
separate sensors package.

**Ports-enabled workspaces can observe and retain sensor evidence.** The
`observe({ sensor, span? })` tool reads one connected sensor, fetches and
verifies every referenced file, and stores the full response and file refs in
the existing snapshot object store before returning. The result includes
measurement values and times, export paths, and a manifest snapshot ref.
`workspace.tools({ images: false })` returns frame paths for `observe` and
`read`. `observe` still retains frame bytes in its exports and snapshots;
`read` leaves its source file unchanged.

**A ports-enabled workspace connects running sensor servers.** The
`connect({ name, process, port })` tool checks process ownership and
readiness, validates the version 1 index, and registers qualified sensor
names in memory for the host run. Equal retries refresh discovery and the
private transport while preserving captured launch source metadata. Process
end makes the connection unavailable, and only its owner can replace it
with a new process.

**The activation reminder shows connected sensor discovery.** It reads the
captured index and checks process state through the existing process table.
It names the workstation hostname, remote sensor port, handle, and qualified
sensor names with descriptions. An ended process shows as unavailable.
Another agent can read the discovery without seeing the owner's process
files or the private transport URL. An explicit repeated `connect` refreshes
discovery.

**The workspace defines the sensor wire contract.**
`@ambionframework/workspace/sensors` exports the version 1 body schemas,
client types, and `createSensorClient(root)` for index, observe, and verified
file reads over a private HTTP transport. The client validates wire bodies,
preserves transport-root prefixes and measurement timestamps, propagates
cancellation, and does not follow redirects or retry requests.
`@ambionframework/workspace/sensor-api.schema.json` publishes the generated
JSON Schema.

**The workspace checks sensor servers.** The existing conformance entry
exports `sensorConformance`. Its cases check server versions, declared names
and span support, observation replies, measurement spans, and file digests.
The Workbench lifecycle test runs the cases against the landed template.

**The workstation forwards private loopback ports over SSH.** The workspace
root exports `WorkspacePort` and `WorkspacePorts`, and `BashBackend` accepts
the optional `ports` capability. `workstationBackend` forwards a remote
`127.0.0.1` service port to an automatically assigned host loopback port.
The caller closes each transport. The URL is private and temporary.

**The workspace retains received sensor evidence in snapshots.** An internal
operation stores verified file buffers and a JSON manifest through the
existing object store. The manifest has `api: 1`, `sensor`, `process`,
`connection`, `request`, `source`, `observations`, and `files`; each file
records its digest and snapshot ref. The source captures launch metadata,
including the dirty marker. Exports use generated filenames in a per-call
directory in the observing agent's home; a complete directory appears only
after the files and manifest are written. The manifest is a regular snapshot
object. The snapshot and journal formats do not change, and no separate
sensor evidence store is added.

**The Workbench adds a forkable sensor-server template.** It serves
deterministic numeric, frame, and text fixtures, captures Git source
metadata at launch, and keeps acquisition files outside its checkout. The
template imports the workspace schemas from a locally built and packed
workspace package because npmjs 0.4.0 does not contain SN1. Its README
documents its setup, customization, validation, process lifecycle, data
retention, and rollback. The Workbench lifecycle test runs SN4 conformance
against a fresh clone.

## 0.4.0 (2026-09-29)

**0.4.0 is a release of simplification.** Each fact of the room has one
derivation, each rule one home, and each seat one boundary. The release
adds four capabilities. They are the post of the host, the `import` of
the `sql` tool, the fixed skills of each agent, and stable refs to
workspace files and commits.

**No journal of 0.3.0 opens on 0.4.0.** The journal carries no format
number, and the `run` entry of 0.3.0 carries one. The section
[Journal bodies](#journal-bodies) lists each body that changed. Ambion
supports no downgrade before 1.0.0.

### Packages

**The eleven packages of 0.3.0 ship at 0.4.0.** No package joins or leaves.
`@ambionframework/workspace` adds the `./s3` entry and removes the `./sql`
entry. Every library package needs Node 22.19 or newer.

### What is simpler

**A concept that had two paths has one.** The sections
[Simplification](#simplification) and [Breaking changes](#breaking-changes)
hold the detail of each.

- **The room state has one derivation.** The projection that a live room
  advances is the only reader. The fold over the whole journal is a test
  oracle.
- **The journal holds five facts.** They are messages, lease changes,
  closes, cancellations, and compositions. A `run` entry fences each run.
  A returned say is a post, and a cancel entry carries no close.
- **One `decide` builds the entries of a command.** A pass of the reconcile
  asks for its writes as commands, and one `decideAndAppend` serves the
  host.
- **The core owns the state of an activation.** The Pi, Claude, and Codex
  executors keep their harness alone: the step mapping, the resume, and how
  they host the tools.
- **One router serves every executor kind.** An `Execution` replaces the
  transport and its composers.
- **The rules read one lease shape.** `RuleLease` replaces four types and
  their converters.
- **One classifier reads the provider text of a permanent failure.** It
  holds the union of the three sets that the executors held.
- **One rule windows the view.** The room applies the message cap and the
  token limit, and the runner pages nothing.
- **One SQL path serves the workspace.** `sqliteBackend` is the only
  workspace code that opens the database.
- **The journal carries no format number.** A `run` entry carries `at`
  alone.
- **An exchange has no owner.** The opening message names who directs the
  work, and `person` names who receives the result.
- **A body schema names each field that an earlier release wrote.** It
  refuses a field that this runtime would misread.

### New

**The host posts a message as the system.**
`room.post({ to?, text, refs?, key? })` writes a `posted` entry with no
author and returns the handle of the exchange that holds it. A post opens an
exchange when none is open, so the host reads `waitForClose`, the usage, and
the outcome of the work it starts. A post routes as a say does, a post with
`to` steers its target alone, and its key has a key space of its own. The
prompt names a post of the host as an event with no direction. The
Cloudflare room object takes `post`. A host no longer defines a person to
wake a seat. See [Exchange](docs/exchange.md#7-the-edges-a-host-sees).

**`sql` imports a CSV file.** The `import` parameter names a CSV file in
the workspace. Its rows are the table `import.rows` for that call alone,
and the statements copy them into the shared tables with
`INSERT INTO ... SELECT`. The file is the CSV that `export` writes, and
every value stays text. See
[Query the shared database](docs/workspace.md#query-the-shared-database).

**Each agent has its own fixed skills.** `loadSkills(source)` reads a set
of skills in the agentskills.io format once on the host, with their
scripts, references, and assets, and refuses a skill that breaks a rule.
`workspace.tools({ skills })` gives the set to one agent. The guidance of
the bundle lists each skill, and each respond activation copies the set
into `~/.skills` in the agent's home. The seat reads a skill with `read`
and runs its scripts with `bash`, so a Pi, Claude, or Codex seat uses a
skill the same way. See [Skills](docs/skills.md).

**A snapshot gives a stable, immutable ref to a workspace file.**
`workspace.snapshot(paths)` reads each file, hashes its bytes with SHA-256,
puts the bytes in the object backend, and gives one ref for each file:
`ambion://workspace/<name>/snapshot/<digest>/<path>`. The same bytes give
the same object, and a later change to the file does not change the ref.
One snapshot takes at most 16 files, and one file holds at most 5 GiB, the
limit of one S3 PutObject. `workspace.readSnapshot(ref)` gives the bytes
back and refuses bytes that no longer match the digest. The `snapshot`
tool gives an agent the same refs, and the `restore` tool writes the bytes
of a ref into the agent's files. See
[Snapshot a file](docs/workspace.md#snapshot-a-file).

**An object backend keeps the bytes of each snapshot.**
`WorkspaceBackends.objects` takes an `ObjectBackend`: `put` and `get` of
bytes under their SHA-256. When it is absent, `openWorkspace` opens a file
store at `layout.snapshots` on the bash backend. `s3ObjectBackend` from the
`@ambionframework/workspace/s3` entry keeps the bytes in a bucket of Amazon
S3, Cloudflare R2, or MinIO, and a put never rewrites an object. The host
holds the credential, so no agent reaches the store. `objectConformance`
holds the cases of a backend, and a CI job runs them on MinIO in Docker.
See [The object backend](docs/workspace.md#the-object-backend).

**A commit ref cites one commit of a workspace repository.** The ref holds
the full hash, and the branch or the tag that named the commit:
`ambion://workspace/<name>/repo/<repository>/branch/<branch>/commit/<hash>`.
The git note states the form, and an agent writes the ref from `git
rev-parse` after it pushes. `workspace.commitRef(repository, at)` gives a
host the ref of a commit on the server, and `workspace.readCommit(ref)`
gives the commit that a ref names: its message, author, parents, and
changed files. See [Cite a commit](docs/git.md#cite-a-commit).

**The Workbench previews every ref.** A snapshot opens in the files panel
as text, a picture, tables, or a note for a binary file. A commit opens as
its log entry and its changes, with where its branch or tag points now. A
room ref opens its room, and a message ref opens its room at the message.
`/attach` cites the copy with a snapshot ref.

**A seat can cite every message it reads.** Each line of the record starts
with the seq of its message, such as `#12`, so a seat builds the message
URI of any line. The closing guidance names the URI of the opening message
of the exchange.

**`recall` reads messages of the room by seq or by URI.** An ordinary
activation calls `recall` with 1 to 16 messages of its room, as `#12`, `12`,
or a message URI, and reads one line for each: the message, or why the room
gave none. It reaches every message that the purpose of the activation may
read, below the cap of `limits.context.messages` too. It commits nothing and
never moves the read position. A response reads a note about it when a message
is out of view. The hosting entry exports `RECALL`, and an agent tool named
`recall` gets a refusal.

**`bash` waits 30 seconds by default.** A test run, a build, or an
install then ends inside its first call more often, so the agent calls
`wait` less. The wait still stops before the activation ends. A person's
correction steers a Pi seat after the call returns, so the default stays
well under a minute.

**`schedule` and `dismiss` speak the model's words.** The descriptions
call a scheduled say a message to yourself, and the room wakes you with it.
The schedule result and the list of pending says use the same words. The
docs keep the term scheduled say.

**The `refs` of `say` and `schedule` name the forms to cite.** Each item
names a snapshot ref, a commit ref, and a message URI. A workspace path and
a table have no ref form, so the text no longer names them. `say` describes
its `text`.

**The executor suite reports each case.** `ExecutorHarness.close` takes an
`ExecutorCaseReport`: the name of the case, every room call with its
answer, and every step the logger received. The live Codex suite writes it
to a JSON file for each case when `AMBION_LIVE_DUMP` names a directory. See
[Executors](docs/executors.md).

### Simplification

- **The room state has one derivation.** `readRoom` replays the
  projection that a live room advances. The fold over the whole journal
  is a test oracle in `test/support/fold.ts`, and
  `projection-equivalence.test.ts` compares the projection with it.
- **`RoomState` lists what the room owes as `due` alone.** The `pending`
  and `owed` lists go. A pending wake has no `seq`, and an owed summary
  has no `writer` and no `through`: `position` and `seat` hold them.
- **`lastOf` leaves the room rules.** The projection keeps the last
  close's `through` and the last seq as it applies each entry, so no room
  code runs `lastOf`. The proofs file defines it for `CloseExtendsTheRecord`.
- **Each room rule has one home.** The copies of `cameToNothing` in
  `room/lease.ts`, `seatOfLease` in `room/transition.ts`, and the rule
  `acknowledged` go. `countsAgainst` counts the failed drafts of a
  summary, and `applyChange` alone keeps `readThrough` from moving back.
- **The room rules read one lease shape.** `RuleLease` replaces `Hold`,
  `Taken`, `Draft`, and `LiveLease`, and the converters `takenOf` and
  `liveLeases` go. `isLive`, `isExpired`, and `coversAttempt` read the
  lease itself. The fold decodes the id of a lease once and keeps its
  fields in `activation`, so the callers of the rules decode no lease id.
  The fold holds no lease whose id the room did not derive.
- **The lease field `since` is now `openedSeq`.** It holds the seq of the
  entry that opened the lease. `since` stays the name of the exclusive
  read cursor of a read and of a pass.
- **`summaryVerdict` has no `covered` input and no `published` verdict.**
  `summaryCompletion` returns a covering summary before it runs the rule.
- **One search finds a covering summary.** `coveringSummary` in
  `room/exchange.ts` serves the summary outcome, the summaries of a
  closed exchange, and the refusal of a second closing commit.
- **`answerView` reads the grant of an activation once.**
- **A cancellation has one shape.** `RoomState.cancelClosed` and the
  schema of the close inside a `cancel` entry go. The wakes and the
  scheduled says drop at the cancellation, and no later filter applies it
  again. A grant keeps its filter, since it reads an id against the whole
  record.
- **A seat of an unknown executor kind fails at once on every router.**
  Under a list of executions, its activation fails with a permanent
  `no_execution` error, as it does in a room with no execution. Before,
  the room sent the wake again after each resend window, with no end.
- **The process table keeps one record for each live process.** A
  process of this run and an adopted process share one map, one stop, and
  one end. The record of a process of this run also holds its environment
  and its abort.
- **The first read that finds a process lost with a `pid` writes its
  `stop`.** The line is `failed <time> The host run ended before the process
  did.` The listing runs no `ps` for that process while `/proc` has no
  directory for its pid. A pid still in `/proc` gets the `ps` check, so a
  `ps` that failed once does not hide a live shell: the next read adopts
  it. The status stays the same. A process with no `pid` gets no line.
  See [Processes](docs/processes.md#the-files).
- **`decide` builds every entry that the room writes.** A pass of the
  reconcile asks for its writes as commands: an end of a lease, the close
  of the exchange that it saw, and the return of a scheduled say. `decide`
  builds each entry where the write lands. One `returnable` rule serves
  the pass and the return of a scheduled say, and the pass asks
  `admitsClose` for the close. One `decideAndAppend` in `room-host/core.ts`
  replaces eleven wrappers of the host around `decide`, and its
  `whileRunning` option writes nothing once the room is gone. A lease end
  takes one object in place of six arguments.
- **A seat release is a command, and one `seatAuthority` checks a seat.**
  The authority is a live lease and the grant of the activation, and the
  grant holds only for a seat on the roster. `view`, `commit`, and a
  release read `seatAuthority`, and `decide` reads it again for a commit
  and a release. A commit whose grant is gone is `stale` where the write
  lands, as it was when the seat asked. The answer of a lease call that
  the room refuses can name another reason; its category stays. See
  [Executors](docs/executors.md#the-room-tools).
- **The host decides a presence change once, and a composition checks each
  name once.** A seating and an unseating by the host commit with no
  decision before the write. `startRoom` checks repeated names and the
  summary writer, and the composition refuses only the name of a person
  of the record.
- **One loop serves the waits of an exchange.** `waitForClose` and
  `waitForSummary` run one loop over one set of waiters. Each publication
  wakes the set after its effect, and the end of the run wakes it once
  more. A wait that the stop or the eviction ends rejects with
  `room_stopped` and the message of the wait, `Exchange '<seq>' was
  stopped or interrupted.`
- **The workspace keeps one SQL path and the ports that a backend uses.**
  The SQL resource opened `node:sqlite` beside `sqliteBackend`, with a
  second copy of the preview and the table render, and it goes. One
  `runScript` replaces six copies of the code that collects the output of
  a script and checks the result, and one `shellQuote` replaces four
  copies of the shell quote. The spill file, `BashBackend.tools`, the
  second check of a git transport, and the knowledge of
  `template-sources` outside `justGitBackend` go.
- **The room applies one windowing rule.** `room/view.ts` keeps the
  newest messages under the cap of `limits.context.messages`, then under
  the `activationTokenLimit` of the seat, never splits a summarised range,
  and keeps the open exchange whole. The runner reads one view and pages
  nothing: `windowedView`, `windowToLimit`, and the page size of 64 go,
  and on Cloudflare a view is one call. The line of one message and the
  blocks of a summarised range move to `record.ts`, where the room and the
  renderer read them. See [History and limits](docs/room.md#history-and-limits).

### Fixes

- **The default assistant works a request after the person who asked
  leaves.** The membership guidance of `@ambionframework/assistant` states
  that the presence of the person who asked does not change the work. The
  assistant seats and routes as for a person who stays, and the closing
  summary goes to the `person` of the exchange. Before this change, the
  model decided, and a question followed by a departure sometimes closed
  with no answer. See
  [Default assistant](docs/assistant.md#seating-and-completion).
- **A Codex seat lands a say in each activation.** A real `codex` numbers
  the items of each turn from `item_0`, and a room tool took the item id as
  the key of its commit. The say of a later activation then had the key of
  an earlier say. The room gave back the earlier message, or refused the
  say as a key conflict. The id of a Codex step now holds the activation
  id, the number of the turn, and the item id. A tool call in a later pass
  of one activation also gets its own `tool_call` step and its tool events.

### Breaking changes

#### Journal bodies

| Body                | The change                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`               | Carries `at` alone, and refuses `format`. Each run of 0.3.0 wrote `format: 1`, so a read refuses a journal of 0.3.0 at its first entry. See [Journal format](docs/durability.md#journal-format).                             |
| `posted`            | New. The host and the room's clock write it with no author. A returned say is a `posted` entry with `to` and `returns`, the seq of the scheduled say. Its record line reads `[posted → <seat>, returns #<n>]`.            |
| `returned`          | Goes. A read refuses it.                                                                                                                                                                                                    |
| `said`              | Refuses `owner`. An exchange has no owner, so a scheduled say names none.                                                                                                                                                                          |
| `close`             | Carries `person` and refuses `owner`. It refuses `summary` with no `person`. It refuses `cancelled`: only the close that the room derives from a `cancel` entry is cancelled.                                               |
| `cancel`            | Carries no close, and refuses `close`. The room derives the close: it closes the open exchange at the last message before the entry, with `cancelled: true`, and a closed exchange reads `cancelled` from it.              |
| `composition`       | Carries no `version`. The room reads a composition by its fields alone, and the refusal of the legacy `assistant` field goes.                                                                                              |
| `lease`             | Stores the read position that its command states. A claim stores 0, and a renewal with no `readThrough` stores 0. The fold keeps the highest position of the lease.                                                        |

**A refusal names the field.** A `dismissed` body with an extra property
fails with `at body.<name>: schema is false`. Every other body accepts an
extra field, and a field that an earlier release wrote fails with
`at body.<name>: expected no such field; an earlier release wrote it`.

#### Exports

- **`@ambionframework/ambion`.** Adds `snapshotUri`, `parseSnapshotUri`,
  `commitUri`, `parseCommitUri`, `REF_LIMITS`, `isPosted`, and the types
  `PostInput`, `PostedMessage`, `SnapshotUri`, `CommitUri`, and `CommitVia`.
  Removes `isReturned` and the type `ReturnedMessage`.
- **`@ambionframework/ambion/hosting`.** Adds `defineExecution`,
  `localExecution`, `visitOf`, `RECALL`, `SCHEDULE`, and the types `Pass`,
  `PassRecord`, `ReadRange`, and `StepSink`. Removes `agentTools`,
  `composeConnector`, `composeExecutions`, `inProcessTransport`,
  `reconcileRoom`, `registerDefaultExecution`, `renderActivation`,
  `renderDelta`, `renderPending`, `resolveReminders`, `roomTools`,
  `seatContext`, `sessionToResume`, and the types `ConnectorComposition`,
  `RenderedPrompt`, `RoomToolBinding`, `SeatContextInput`, `Transport`, and
  `ViewRange`.
- **`@ambionframework/ambion/conformance`.** Adds `portConformance` and the
  types `PortHarness` and `ExecutorCaseReport`. Removes
  `transportConformance` and the type `TransportHarness`.
- **`@ambionframework/workspace`.** Adds `loadSkills`, `fromDirectory`,
  `runScript`, `shellQuote`, `sqlImport`, `SNAPSHOT_LIMITS`, `ToolFailure`,
  and the types `SkillSet`, `SkillInfo`, `SnapshotOptions`,
  `SnapshotDetails`, `ScriptRun`, `WorkspaceToolsOptions`, `ObjectBackend`,
  `ObjectEnv`, `ObjectDigest`, `FileSource`, `SourceFiles`, `SourceInput`,
  `SqlProvenance`, `SqlImported`, `SqlImportTable`, `WorkspaceRead`,
  `GitRevision`, `GitCommit`, and `GitChange`. Removes `spill`, `spillPath`,
  and the type `MinimalWriter`.
- **`@ambionframework/workspace/git`.** Adds `revisionOf`, `validRefName`,
  `assertCommitHash`, and `byPath`. Removes `SOURCES`, `fromDirectory`, and
  the types `TemplateSource` and `TemplateFiles`.
- **`@ambionframework/workspace/s3`.** Is a new entry: `s3ObjectBackend` and
  the type `S3ObjectBackendOptions`.
- **`@ambionframework/workspace/sql`.** Goes, with `openSqlResource`,
  `PROVENANCE_COLUMNS`, and the types `SqlResource`, `SqlResourceEnv`, and
  `SqlResourceOptions`. The type `SqlProvenance` moves to the root entry.
- **`@ambionframework/workspace/conformance`.** Adds `objectConformance` and
  the types `ObjectConformanceBackend` and `ObjectConformanceStore`. Removes
  `sqlConformance` and the type `SqlConformanceBackend`.
- **`@ambionframework/ambion/testing` and `@ambionframework/pi/testing`.**
  Each adds `later`, a scripted call of `schedule`.

**The other entries keep their exports.** The bullets below name each
option, member, and type that changed inside an export.

#### Definitions, executors, and hosting

- **One classifier names a permanent failure.** `classifyCause({ text,
  status })` takes no `permanent` pattern. The core holds the text set of
  every provider that a shipped family reaches. The set is the union of the
  three copies that the Pi, Claude, and Codex executors held. The Pi executor
  now also reads `not logged in`, `x-api-key`, `missing bearer`, and
  `invalid-api-key` as permanent. The Claude executor also reads
  `insufficient_quota`, `exceeded your current quota`, and `missing bearer`.
  The Codex executor also reads `billing_error` and `x-api-key`. The Claude
  package no longer has `causeOf`. See
  [Executors](docs/executors.md#failure-classification).
- **The core owns the state of an activation, and a pass receives what the
  core decides.** The Pi, Claude, and Codex executors each kept the read
  position, the cut, the refresh test, and the binding of the room tools.
  Each also raised the `error` event, kept the freshness of a steer, and
  assembled the prompt. The core now keeps each one, and an executor keeps
  its harness alone. The driver opens the state of each activation, and the
  hosting entry does not export it. See [Executors](docs/executors.md#the-pass-contract).
  - **`ExecutorSession`** has no `readThrough`, `cancelled`,
    `shouldRefresh`, or `abort`. `session` is the id of the harness session,
    and the core adds the harness name. `pass` takes a `Pass`. The optional
    `roomTools` adds to a say and a schedule, as `RoomToolOptions` did.
  - **`ExecutorActivation`** has no `room` and no `emit`. It holds `id`,
    `trace`, `signal`, `readThrough`, `read(range)`, `delivered(call)`, and
    `callId(tool)`. The cut of the activation aborts `signal`. `trace` is a
    `StepSink`, a new type that holds `record` alone. The driver keeps the
    rest of the `TraceSink`.
  - **`Pass`** is new: the `PassInput`, `mechanism`, `agent`,
    `record(after?)`, `resume`, `tools`, and `agentTools`. `PassRecord` and
    `ReadRange` are new types. `Executor.harness` names the harness whose
    sessions the executor records. `PassResult.error` carries the error of
    the `error` event.
  - **The core raises the `error` event once.** An executor raises none, and
    the driver raises none of its own for a lost room call. The event
    carries `PassResult.error`, or an error built from the message. The
    `end` step of a seat that no execution serves now names the reason.
  - **The core raises the tool events from the steps.** It pairs the
    `tool_call` and `tool_result` steps by call id. A harness that cannot
    see the id of a call takes it with `callId`. A room tool that
    commits an entry raises no tool event: `say`, `schedule`, `seat`,
    `unseat`, and `dismiss`. The `message` event of the entry already
    reports the call, so a tool event reported the same fact twice. Codex
    held this rule. The Pi and Claude executors now raise no tool event for
    `seat`, `unseat`, and `dismiss`. `recall` commits nothing, and it
    raises tool events on every executor.
  - **The core keeps the freshness of a steer.** The algorithm of the Pi
    executor moves into the core with no Pi type. The Claude executor drops
    its echo check. A steered line that lands out of order now counts once
    the gap closes, as it did on Pi. Of two held ranges through one
    position, the core keeps the range that starts lower. The order of the
    ranges no longer changes the position read.
  - **The hosting entry removes** `renderActivation`, `RenderedPrompt`,
    `renderDelta`, `renderPending`, `resolveReminders`, `sessionToResume`,
    `roomTools`, `agentTools`, and `RoomToolBinding`. The core renders the
    prompt and binds the tools. It adds `Pass`, `PassRecord`, `ReadRange`,
    and `StepSink`.
  - **The executor suite checks the pass contract.** A failed activation
    raises exactly one `error` event, and a `say` raises no tool event.
    The Codex executor runs the suite in its live tier.
  - **The scripted executor calls the room tools of the pass.** It records
    a `tool_call` and a `tool_result` step for a tool of the agent, and the
    core raises the tool events from them. It calls `delivered` for each
    result of a room tool, as a model loop does. A closing activation of it
    ends with the `stopped` end step.
- **The remote call is an `Execution`, and one router serves every kind.**
  The hosting entry exports `localExecution(kind, build)`. It returns an
  `Execution` of that kind, whose port is an `AgentRunner` in this process.
  `defineExecution(kind, build)` returns the same execution and makes it
  the default of its kind. `Execution` has an optional `kind`, and an
  execution with no kind serves every kind.
  `execution` of `createRuntime`, `startRoom`, and `resumeRoom` takes one
  execution or a list. A seat runs on the first execution of the room for
  its kind, then on the first of the runtime, then on the default of its
  kind. A miss fails at once with a permanent `no_execution` error whose
  message names the seat and the kind. `Hosting.execution` is
  `Hosting.executions`, and `ExecutionHost` has no `transport`. See
  [Executors](docs/executors.md#the-hosting-entry-exports).
  - **The hosting entry removes** `Transport`, `inProcessTransport`,
    `composeExecutions`, `registerDefaultExecution`, `composeConnector`,
    `ConnectorComposition`, `seatContext`, and `SeatContextInput`.
    `createRuntime` has no `transport` option. A list in `execution`
    replaces `composeExecutions`. `defineExecution` replaces
    `registerDefaultExecution`, and `localExecution` replaces
    `composeConnector`. A test wraps the ports of an execution where it
    wrapped a transport.
  - **The conformance entry renames** `transportConformance` to
    `portConformance`, and `TransportHarness` to `PortHarness`. The cases
    and their names stay.
  - **Every execution keeps the trace limits of the host.**
    `claudeExecution()` and `codexExecution()` read `limits.trace` of the
    runtime. Before, they applied `DEFAULT_TRACE_LIMITS`.
  - **`piExecution()`, `claudeExecution()`, and `codexExecution()` return
    `Execution<AgentRunner>`.** A call changes no default. Loading the
    package defines the default of its kind once, with no options.
  - **The Cloudflare seat object builds its executor once.** It connects
    the Pi execution of the worker once, and it keeps the runner and the
    executor on the object instance. The room object reaches each seat
    through `rpcExecution`.
- **`RoomProtocol.view` takes no range, and `ViewRange` goes.** The
  second argument is `message`, a seq: the view then holds that one
  message when the purpose may read it, and no window applies. `recall`
  reads a message below the window this way. `CollaborationContext` has
  no `earliest`, and `omitted` counts what the cap and the token limit
  leave out. The hosting entry exports no `ViewRange`.
- **`estimateTokens` is the name of an estimator.** The executor option of
  `pi()`, `claude()`, and `codex()`, and `AgentExecutor.estimateTokens`,
  take a string in place of a function. `createRuntime({ estimators })`
  registers each estimator by name, and every runtime holds `length`,
  `Math.ceil(text.length / 4)`, the default. A host cannot register
  `length`. `startRoom` and `resumeRoom` fail with `missing_definition`
  when a definition names an estimator that the runtime does not hold.
  `configure` of `@ambionframework/cloudflare` takes `estimators` for the
  runtime of the room object. The seat object runs no estimator, because
  the room object windows the view.
- **A rendered record line starts with `#<seq>`.** `renderLine` in
  `@ambionframework/ambion/hosting` writes it, so a record line, a `[new]`
  line, and a steer carry it.
- **Pi is 0.87.** A `stream` that `piExecution` takes gets Pi's
  `TranscriptContext`. System messages carry the prompt and the tools. A
  `Script` from `@ambionframework/pi/testing` still gets `systemPrompt`
  and `tools`.
- **`callTool` takes a `JsonObject`.** Pi types tool arguments as JSON.
- **One capture serves a definition.** `defineHuman` and the room apply
  the same capture to a person, and `defineAgent` and the room apply the
  same capture to an agent. A room trims the `preferences` of a person
  that `defineHuman` did not make, and drops blank `preferences`.
  `defineAgent` checks and copies the executor as the room does, so a
  malformed executor fails at `defineAgent`. The `executor` of the
  definition is a frozen copy of the executor that the caller gives.
- **The Cloudflare objects call the core.** The hosting entry removes
  `reconcileRoom`: a host calls `reconcile()` on the room. It exports
  `visitOf(room, name)`, the visit of a person whom the record holds
  present, and it writes nothing. `AgentRunner.recover(activation)`
  releases as failed a run that the host lost. The room object keeps no
  copy of the visits, and its alarm calls `reconcile()`. The seat object
  releases a run that an eviction lost through `recover`. See
  [Executors](docs/executors.md#the-hosting-entry-exports).
- **One scripted room serves both conformance suites.** `portConformance`
  and `executorConformance` play the same room, with one question, one
  participants block, and one stale answer. The cases and their names
  stay. The polling of a case takes an async predicate.

#### The room and the exchange

- **An exchange has no owner.** The opening message names who directs the
  work, and `awaiting` reads its author. `person`, the first person who
  spoke in the range, names who receives the result: the summary, its
  recipients, `ctx.exchange.person`, and `waitForSummary`. `ExchangeRef`,
  `ExchangeHandle`, `ExchangeView`, the `exchange_opened` and
  `exchange_closed` events, `ToolContext.exchange`, and the seat protocol
  carry `person?` in place of `owner`. A `close` entry carries `person`,
  refuses `owner`, and refuses `summary` with no `person`. The close
  command carries no owner, and `admitsClose` compares `from` alone.
- **A scheduled say carries no owner.** The `said` entry refuses `owner`,
  and `PendingSay` has none. A
  returned say opens an exchange with no `person`, and an exchange where
  no person spoke owes no summary, so a seat that schedules again no
  longer owes a person a summary for each return. A seat schedules from
  any response activation: the refusal "No exchange is open" goes. The
  note of a process tool that points to `schedule` shows with no exchange
  open.
- **A say to oneself steers no seat.** A scheduled say steered each
  colleague at work, and a colleague read another seat's note to itself.
- **The prompt names a returned say by its seat.** The opening line of an
  exchange that a returned say opened reads `Exchange <n> is active:
  message <n> is a say you scheduled, and the room returned it.`, and a
  colleague reads the name of the seat. The record line of a returned say
  drops `for <owner>`.
- **The kernel names no database.** The hand-off guidance of every seat said
  to put structured data in the shared database and named `sqlite_master`,
  even for a seat with no SQL backend. It now says to write an artifact once
  where the tools keep it, and to hand it off with a directed say. The
  guidance of `sql` names the table or view hand-off, and the SQLite backend
  names `sqlite_master`.
- **The room takes a scheduled say at any read position.** A scheduled
  say never gets a `missed` answer. A `committed` answer to it lists in
  `unread` the messages after its `readThrough` and before the say. The
  `schedule` tool result shows them.
- **The kernel defines two more `ambion:` forms.** `snapshotUri`,
  `parseSnapshotUri`, `commitUri`, `parseCommitUri`, the `SnapshotUri`,
  `CommitUri`, and `CommitVia` types, and `REF_LIMITS` join the root entry.
  The room accepts a canonical snapshot ref and commit ref, and refuses any
  other `ambion://workspace/` string.

#### Agent tools

- **The audit entry of a failed process keeps its details.** A call that
  fails on a process that ended badly throws a `ToolFailure`, and its audit
  entry holds `error.details`: the `ProcessStatus` and the read range. The
  error name is `ToolFailure` in place of `Error`. `AuditEntry.error` has
  `details`.
- **A wait on several handles bounds its output and names the handles to
  drop.** It shows the output of the processes that ended until its text
  holds about 50 KB. A process past that gives its state line and asks for
  `status`, and its cursor stays. The last line names each handle that
  ended, because a wait that holds one returns at once. The description of
  `wait` states the same rule.
- **A room tool result names what landed.** `say` gives `said #<seq>`,
  with `to <name>` for a directed say, so the agent can cite its own
  message. `seat` and `unseat` give `seated <name> (#<seq>)` and
  `unseated <name> (#<seq>)`. A membership that the record already holds
  gives `<name> is already seated` or `<name> is not seated`. The result
  was `delivered` before.
- **A process that ended badly fails every call that reports it.** An
  exit code other than 0, a timeout, and a failed process make `bash`,
  `status`, and `wait` a tool error, so one state has one shape on every
  tool. The error text is the output and the state line. A refused
  statement of `sql` and a refused fork are tool errors, and their text
  states the next step, and so does a failed clone of `fork`. `recall`
  fails when a ref finds no message, and its text holds every line.
  `cancel` of a process that had ended says that it stopped nothing.
- **`fetch` is `restore`.** A model reads `fetch` as a web request, and
  the shell has no network. `restore` takes the same `{ ref, path? }` and
  puts the bytes of a cited snapshot in the agent's files.
- **`wait` takes `{ handles, timeout? }`.** `handle` goes, and `handles`
  holds 1 to 16 handles. One handle gives the result of `status`. Several
  give the output of each process that ended and the state of each one
  that still runs. The schema states the bounds. A call with `handle` fails
  with `Invalid arguments for tool 'wait': must have required properties
  handles.`
- **A tool of `defineTool` names the rules that its arguments break.** The
  error was `Invalid arguments for tool '<name>'.` It is now `Invalid
  arguments for tool '<name>': <rules>.`, with each property path and its
  rule, so the model can correct the call.
- **The preview size of `sql` is `rows`.** The tool parameter
  `maxRows` becomes `rows`, the one camelCase name that a model wrote. The
  host option and `SqlRunOptions` keep `maxRows`.
- **`dismiss` takes `{ message }`, the seq of a scheduled say.** The word
  handle now names a process alone. The `schedule` result, the list of
  pending says, and the dismissal results show the say as `#<seq>`, as the
  record shows it. `room.dismiss` names its argument `seq`.
- **`schedule` is a room tool, and `say` has no `after`.** An agent calls
  `schedule` with `{ after, text, refs? }` to come back to its work. The
  tool writes the same `said` entry with `to` and `after` as before, so
  the journal body does not change. An agent tool named `schedule` gets
  a refusal. The hosting entry exports `SCHEDULE`. The process note and
  the guidance of the process tools name `schedule`.
- **Every workspace has ten tools.** `snapshot` and `restore` follow the
  process tools, and their note follows the process note in the guidance.

#### The workspace and its backends

- **The provenance column `exchange_owner` becomes `exchange_person`.**
  The provenance columns that `sqliteBackend` fills, `SqlProvenance`, and
  the `exchange` of an audit entry carry `person`. An exchange with no
  person leaves `exchange_person` NULL.
- **`GitEnv` has `resolve(id, at)` and `show(id, hash)`.** A custom git
  backend gives the full hash that a branch, a tag, or a hash names, and
  the message, author, parents, and changed files of one commit.
  `@ambionframework/workspace/git` exports `revisionOf`, `validRefName`,
  `assertCommitHash`, and `byPath`. The root entry exports `GitRevision`,
  `GitCommit`, and `GitChange`.
- **`WorkspaceLayout` has `snapshots`.** A custom bash backend and each
  `workstationBackend` layout name the folder of the default object store.
  The just-bash backends use `/snapshots`. On a workstation, the host account
  owns the folder with mode `2750`, the same as `layout.rooms`.
- **The root entry exports `ObjectBackend`, `ObjectEnv`, and `ObjectDigest`.**
  The `./conformance` entry exports `objectConformance`, and
  `@ambionframework/workspace` depends on `aws4fetch`.
- **`fromDirectory` moves to the root entry of `@ambionframework/workspace`.**
  `@ambionframework/workspace/git` no longer exports it.
  `TemplateSource` and `TemplateFiles` become `FileSource` and
  `SourceFiles` in the root entry, beside the new `SourceInput`. The `/git`
  entry keeps `filesOf`, `hashesOf`, `sameFiles`, `changeTo`, and
  `TemplateRegistration`.
- **`WorkspaceFiles` has `readFile(path, maxBytes, context)`.** A custom
  `WorkspaceFiles` implements it.
- **`SqlRunOptions` has `import`, and an `ok` `SqlOutcome` has `import`.**
  A custom `SqlBackend` stages the file in `import.rows`, with
  `sqlImport` from the root entry, or refuses the option.
- **The root entry exports `sqlImport`, and the types `SqlImported`,
  `SqlImportTable`, and `WorkspaceRead`.**
- **An export quotes the text `\N` as `"\N"`.** A bare `\N` is a NULL
  alone, so the text `\N` reads back as text.
- **A workspace env has `openTextLineReader`.** `HomeEnv` supplies it
  from `readTextFile`. A backend without `HomeEnv` implements it.
- **The `./sql` entry of `@ambionframework/workspace` goes.**
  `openSqlResource`, `PROVENANCE_COLUMNS`, and the types `SqlResource`,
  `SqlResourceEnv`, and `SqlResourceOptions` go, with the `query` and
  `record` tools. An agent adds a row with an INSERT through `sql`, so no
  tool shares the word record with the journal of a room. The SQL backend
  of a workspace holds records:
  `sqliteBackend(location, { schema, appendOnly, provenance })` runs the
  schema at each open, keeps each `appendOnly` table to INSERT alone, and
  fills the provenance columns of a new row. With `appendOnly`, a call
  cannot create a trigger, and only the guard triggers call the guard
  functions. `SqlRunOptions` has
  `provenance`, the root entry exports the type `SqlProvenance`, and the
  `sql` tool passes the provenance of each call. The Workbench keeps its lab
  records in the database of the `sql` tool, `lab.db`, and `shared.db`
  goes. An agent can now add a project to the Workbench lab. See
  [Records](docs/workspace.md#records-append-only-tables-with-provenance).
- **`sqlConformance` and `SqlConformanceBackend` leave `./conformance`.**
  The SQL cases run in the SQLite tests until a second SQL backend exists.
- **A backend writes no spill file.** The root entry no longer exports
  `spill`, `spillPath`, and `MinimalWriter`. The just-bash backends and
  the workstation ignore `capture.spill`, and a result has no
  `spillPath`. Every `bash` call keeps its whole output in a process file.
  The conformance case of the bounded view checks no spill file.
- **The root entry exports `runScript` and `shellQuote`.** `runScript`
  runs one script and gives its exit code and its output as text.
  `shellQuote` puts one word in single quotes for `bash`.
- **`BashBackend.tools` goes.** No backend set it. The workspace binds
  the same tools over every bash backend.
- **`openWorkspace` alone checks a git transport.** The just-bash
  backends and the workstation read `BashServices.git` at `connect` with
  no check of their own.
- **`template-sources` belongs to `justGitBackend`.**
  `@ambionframework/workspace/git` no longer exports `SOURCES`.
  `assertAgent` and `readOnly` know `templates` alone. `justGitBackend`
  refuses an agent named `template-sources` and hides the namespace. The
  workstation no longer knows the name. `GitConformanceBackend` has no
  `sourcesCredential`, and the git cases no longer check
  `template-sources`.

## 0.3.0 (2026-09-25)

**The work of a seat outlives its activation.** A shell command runs as a
background process, and an agent comes back to its work with a scheduled
say. A workstation keeps git repositories for its agents, and the
simulator runs evals on a room. Every library package needs Node 22.19 or
newer.

### Packages

| Package                              | What it gives                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`            | The kernel: room, journal vocabulary, rules, and hosting                              |
| `@ambionframework/journal`           | The append-only journal                                                               |
| `@ambionframework/assistant`         | The default assistant                                                                 |
| `@ambionframework/pi`                | The Pi executor, and `runAgent` for one agent outside a room                          |
| `@ambionframework/claude`            | The Claude Agent SDK executor                                                         |
| `@ambionframework/codex`             | The Codex SDK executor                                                                |
| `@ambionframework/cloudflare`        | A room and its seats as Durable Objects                                               |
| `@ambionframework/workspace`         | The workspace interface, its tools, a SQLite backend, and the git helpers in `./git`  |
| `@ambionframework/just-bash`         | A shell and a filesystem in the process, and `justGitBackend` in `./git`              |
| `@ambionframework/workstation`       | A shell over SSH on one server, one Unix account per agent, and `workstationGitBackend` |
| `@ambionframework/simulator` (new)   | Evals: an actor plays a person in a room, and a judge grades the run                  |
| `@ambionframework/git` (retired)     | Use `@ambionframework/just-bash/git`                                                  |

### New

**A shell command runs in the background.** `bash` starts every command as
a background process and returns a handle. A process outlives the call and
the activation that started it. The files of the bash backend hold the
process table, so a new run of the host reads the same table. No message
wakes a seat when a process ends: the agent waits for the result inside
the activation, and the guidance says so. A host that wants a wake posts a
message. See [Processes](docs/processes.md).

```ts
import { defineHuman } from '@ambionframework/ambion';

const lab = defineHuman({
  name: 'lab',
  identity: 'The lab host. It reports each process that ends.',
});
const visit = await room.visit(lab);
workspace.processes.subscribe((event) => {
  const { handle, name, agent, state, room: started } = event.process;
  if (event.type !== 'ended' || started !== room.name) return;
  visit
    .send({
      to: agent,
      text: `Process ${name ?? handle} is ${state}. Call status with ${handle} for its output.`,
      key: `process-ended:${handle}`,
    })
    .catch((error: unknown) => log.error(error));
});
```

- **`ps`, `status`, `wait`, and `cancel` join `bash`.** `ps` lists the
  running processes of the caller. The handle tools take a handle of the
  caller. `bash` takes an optional `name`, a label that `ps` and the
  reminder show. Each process is a directory,
  `~/.processes/<handle>/`, that holds the spec, the whole output in
  `out`, the process id, and the end.
- **A result gives the new output.** `bash`, `status`, `wait`, and
  `cancel` give the output after a cursor that the process keeps in
  `~/.processes/<handle>/cursor`, and move it. `details.read` holds the
  byte range. A poll of a long build gives each part once. Each read goes
  through the shell capture, which removes escape sequences and carriage
  returns, as Pi's `bash` tool does.
- **`wait` takes `handles`.** It returns when the first of up to 16
  processes ends, with the new output of each process that ended and the
  state of each one that still runs.
- **A wait ends before the activation does.** The room puts `deadline` on
  each view, and `ToolContext.deadline` carries it to each tool call: when
  the room ends the activation, in milliseconds on the wall clock. `bash`
  and `wait` stop their wait 30 seconds before it, and the result says so.
- **A new run of the host adopts the live processes of an earlier run.**
  The table re-arms the timeout of each one, and `cancel` stops it through
  its process id. A process that ended with the earlier run, with no exit
  file, is `failed` with the message "The host run ended before the
  process did."
- **`Workspace.processes` is the host's view.** `list`, `subscribe`, and
  `cancel` reach the processes of the agents that used the workspace in
  this run. `list` returns a promise. The root entry of
  `@ambionframework/workspace` exports `ProcessEvent`, `ProcessKind`,
  `ProcessQuery`, `ProcessState`, `ProcessStatus`, and
  `WorkspaceProcesses`.
- **A tool bundle can remind a seat.** `ToolBundle.remind` gives text, or
  a promise of text, for each respond activation, and
  `AgentExecutor.reminders` holds the reminders of the bundles. The
  executor resolves them once for each activation, with a bound of 5
  seconds for each, and aborts the signal of a reminder at the bound.
  `renderActivation` takes the resolved text as its third argument and
  adds it before the ask line. The main entry exports `Reminder` and
  `ReminderSeat`. The hosting entry exports `resolveReminders` and
  `REMINDER_TIMEOUT_MS`. The Pi executor sends a continued session the
  reminders before the delta. The workspace reminds each seat of its
  processes.
- **The workstation keeps a session open while any environment is open
  over it.** A process holds an environment for its whole run.
- **The workbench shows the background processes with `/ps`.** A side
  panel lists the processes of the agents, shows the end of the chosen
  output, and cancels a running process on a second `x`.

**An agent comes back to its work later.** An agent says to itself with
`after`, in seconds. The exchange closes while the say waits. When the say
is due, the room writes a returned say, which wakes the agent and opens an
exchange for the owner of the first one. See
[Exchange](docs/exchange.md#6-a-scheduled-say).

- **`say` takes `after`.** A say to oneself with `after` schedules it. The
  room stamps `owner`, the owner of the open exchange, on the said entry,
  and refuses `after` in any other say. The result names the due time and
  the seq of the say as its handle.
- **The `returned` entry.** The room writes `{ to, message, owner, text,
  refs }` when a scheduled say is due. It has no `from`. It wakes one
  seat, the one that `to` names, and steers no other. It opens an exchange
  for `owner` when none is open. `isReturned` and `ReturnedMessage` are
  new exports.
- **`limits.schedule`** bounds `after` from `minAfter` to `maxAfter`
  seconds, 60 to 604,800 by default, and the says of one seat that wait,
  `pending`, 4 by default.
- **The agent sees its pending says.** `CollaborationContext.scheduled`
  carries the pending says of the seat in each response activation, and
  the render lists them. `renderPending` in `/hosting` gives that list for
  a seat that continues its session.
- **A seat or the host dismisses a pending say.** The `dismiss` tool takes
  the handle of a pending say of the seat, and the room writes a
  `dismissed` entry `{ from, message }`. The room does not return the say.
  `room.dismiss(handle)` dismisses any pending say, with no `from`, and
  returns whether it wrote the entry. `room.scheduled()` lists the pending
  says. The Cloudflare room object serves them as `dismiss` and
  `scheduledSays`, because Workers keep the name `scheduled`.
  `DismissedMessage` is a new export, and `/hosting` exports `DISMISS`.
- **`RoomRead.scheduled` lists the says that wait to return**, each a
  `PendingSay` with its due time. `PendingSay` is a new export.
- **The workbench shows a returned say, and notes each say that waits.**
  Each note names the handle of the say. `/dismiss <n>` dismisses the say,
  and the palette lists the says that wait. A dismissed say reads
  `dismissed` in place of its return time.

**A workstation keeps the git repositories of its workspace.** One
account on the server, such as `lab-git`, owns every repository. Each
agent clones and pushes with its own `git` over SSH, with a key that works
only from the server and only until `keyTtl`. The host opens no port. See
[Workstation git](docs/workstation-git.md).

- **`workstationGitBackend`** prepares the account, writes the forced
  command `~/.ambion/serve`, registers each template by a rename, and runs
  `list`, `get`, and `fork` as scripts on the server. A fork lands with
  one rename. `identityFor` issues an Ed25519 key for each agent and
  writes its line to `~/.ssh/authorized_keys.ambion` under `flock`, with
  `restrict`, `from`, `expiry-time`, and `command`.
  `@ambionframework/workstation` exports `workstationGitBackend`,
  `WorkstationGitOptions`, `WorkstationGitAccess`, and
  `WorkstationGitIdentity`.
- **`workstationBackend` carries the git transport `ssh`.** Its
  `gitTransports` is `['ssh']`, so it pairs with `workstationGitBackend`.
  At each `connect`, it writes the agent's key, a `known_hosts` file, and
  an ssh configuration for the alias into `~/.ssh` with mode `0600`. It
  makes `Include ambion-git.conf` the first line of `~/.ssh/config`, and
  it keeps the other lines.

**`@ambionframework/simulator` runs evals on a room.** `simulate(room,
options)` drives a room that the test started. An actor plays a person,
one exchange at a time, and the loop waits for the close and the summary
under one deadline, `exchangeMs`. The run holds the moves, each exchange
with its closed view, one read of the room, the events, and the usage. It
ends with `stopped`, `limit`, `timeout`, or `failed`. See
[Simulator](docs/simulator.md).

- **`scriptedActor`** plays a fixed list of moves.
- **`agentActor` and `agentJudge` run the person and the grade on a
  model.** Each takes `model`, `tools`, `bundles`, `services`, and
  `timeoutMs`, and runs on `runAgent`. The actor ends each move with
  `send` or `stop`, and the tools see the person in `ctx.agent`. The judge
  reads the record between two lines that carry a random token, and ends
  with `grade`: one finding for each criterion, in the order of the list,
  reason first. The judge attaches each criterion, and `grade` refuses a
  list of the wrong length.
- **`runAgent` runs one Pi agent outside a room.** It takes a model, a
  routing name, the agent that the tools see, a system prompt, one prompt,
  tools and bundles, and the names of the tools that end the run. It runs
  Pi's `AgentHarness` until the agent calls one of them, and returns that
  call, the calls before it, and the usage of every request. A `signal`
  aborts the run. `@ambionframework/pi` exports `runAgent`,
  `RunAgentRequest`, `RunAgentResult`, and `RunAgentCall`.
- **A Pi seat takes a thinking level.** `pi({ thinking })` takes a Pi
  `ThinkingLevel`, and the harness sends it to the provider. Absent, the
  level is `off`, as before. `runAgent`, `defineAssistant`, `agentActor`,
  and `agentJudge` take `thinking` too.
- **The assistant's live suite runs on the simulator.** It passes on
  `anthropic/claude-sonnet-5` and `openai/gpt-5.6-luna` at `medium`, and
  each model grades the other.

### Fixes

- **A spent usage limit, a billing refusal, or a spent quota fails in one
  attempt.** The Pi, Claude, and Codex executors read `usage limit` and
  `billing_error` as permanent. Pi also reads `insufficient_quota` and
  `exceeded your current quota`. OpenAI sends a spent quota with a 429, so
  before this change a Pi seat on OpenAI retried it to the cap. A rate limit
  stays transient.
- **A Pi seat with a model the registry does not hold fails in one
  attempt.** `Unknown model`, and the harness codes `model_unavailable` and
  `configured_tools_unavailable`, are permanent. A retry reads the same
  configuration. Before this change, the room retried them to the cap.
- **A failed activation names the failure in the provider's words.** A
  provider error that arrives as a status and a JSON body, as in `400
  {"type":"error",...}`, now reads `400 invalid_request_error: <message>
  (request <id>)`. The Pi, Claude, and Codex executors give this text to the
  trace, the `error` event, and the pass result. `providerMessage` in
  `@ambionframework/ambion/hosting` makes the text for another executor.
- **The Workbench shows why a closed exchange has no reply.** When the room
  gave up on a reply, the line under the exchange names the seat, whether
  the room retried, and the reason from the trace. `/steps` opens the
  attempt that ran, and not the attempt the room abandoned after it.
- **`directoryBackend` runs each filesystem change as trusted code of
  just-bash.** just-bash 3.4.2 starts a queued change in the async context
  of the change before it. When a script made that earlier change and then
  ended, the defense layer of just-bash blocked the queued change. Each
  later change on the directory then waited with no end, and so did the
  workspace owner, `wait`, and the host's list of processes.

### Breaking changes

There is no compatibility promise before 1.0.0. Some journal bodies
changed. A 0.3.0 runtime reads a 0.2.0 journal, and a 0.2.0 runtime must
not read a 0.3.0 journal.

- **The journal changes.** A said entry takes `after` and `owner`, and the
  `returned` and `dismissed` entries are new. A returned say opens an
  exchange, so the verified rule `opensExchange` accepts it.
- **`Message` has two more members, `ReturnedMessage` and
  `DismissedMessage`.** Code that switches on `kind` meets `returned` and
  `dismissed`.
- **`Room` has `dismiss` and `scheduled`, and `RoomRead` has
  `scheduled`.** A value that implements `Room` or builds a read by hand
  adds them.
- **A respond activation has the `dismiss` tool, and `say` has an `after`
  parameter.** A tool name `dismiss` of an agent gets a refusal, and a
  tool list or schema that a test pins lists both.
- **`bash` returns a handle, and waits up to `wait` seconds, 10 by
  default.** A command that runs longer keeps running, and the result
  says so. A process can run for `timeout` seconds, 600 by default. Before,
  a command held the bash owner and stopped after 30 seconds by default.
- **Every workspace has eight tools before the tools of its other
  backends.** The tool line of the guidance counts them.
- **`dispose()` stops every running process of this run** before the bash
  backend releases its handles.
- **The default assistant is passive at `broadcast`, and keeps to
  membership and summaries.** It sends nothing to a specialist at
  `broadcast` or `presence` attention. It sends no correction, no relay,
  and no question to the person during the exchange. The summary reports
  a superseded fact, a broken constraint, and a question for the person.
  The assistant answers a person or a specialist that addresses it, and it
  sends one directed request to an idle specialist at `named` attention. A
  constraint stays in force until the person withdraws it. Its identity
  now reads "Room assistant. Seats and unseats specialists as the request
  needs, and summarizes each exchange." See
  [Default assistant](docs/assistant.md).
- **`@ambionframework/git` is gone.** Its git backend moves into the new
  entry `@ambionframework/just-bash/git`, and the template helpers move
  into the new entry `@ambionframework/workspace/git`. The root entry of
  `@ambionframework/just-bash` loads no `node:sqlite`.
- **`justGitBackend` has no `handler` and no `url` option.** Every clone
  URL starts with `http://git.ambion.invalid`, and the backend serves the
  process it runs in.
- **`GitAccess` holds `transport` alone.** `prefix`, `fetch`, and
  `credentialFor` move to `JustGitAccess`, and `credentialsFor` goes.
  `JustGitBackend.access` is a `JustGitAccess`, whose `transport` is
  `in-process` and whose `fetch` is always set.
- **A bash backend lists the git transports it carries in
  `BashBackend.gitTransports`.** `openWorkspace` throws when the bash
  backend does not carry the `transport` of the git backend. The error
  names that transport, the `server` of the git backend, and the
  transports of the bash backend. A bash backend with no `gitTransports`
  carries none. `memoryBackend` and `directoryBackend` carry
  `in-process`, and they refuse an access of another transport at
  `connect`.
- **The workstation writes no `~/.git-credentials`.** Its agents reach
  git through `workstationGitBackend` and the `ssh` transport.
- **A registration with a changed source updates its template.** Before,
  it failed with an error that named the template, and the host
  registered the change under a new name. Now both git backends
  fast-forward `templates/<name>` to a new commit whose parent is the old
  tip. A changed description replaces the old one. A fork keeps the
  commit it came from. `justGitBackend` commits the change to
  `template-sources/<name>` and moves the template's ref. `Registry` gets
  `describe`.
- **`gitConformance` asks the harness for each credential fact.**
  `GitConformanceBackend` gets four hooks: `sourcesCredential`,
  `issueCredentials`, `writeCredential`, and `probeCredential`. Each hook
  takes the pair that the case opened, a `GitConformancePair`, and
  `probeCredential` gives a `GitConformanceProbe`. The conformance entry
  exports both types. `GitConformanceBackend`, `GitConformanceStore`, and
  `gitConformance` take the type of the git backend as a parameter.
  `GitConformanceOptions.tokenTtl` is now `credentialTtl`, and
  `GitConformanceBackend.shortestTokenTtl` is now `shortestCredentialTtl`.

**Removed and moved names, by entry:**

| Entry                        | Change                                                                                                                                                                                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ambionframework/git`       | Moved to `@ambionframework/just-bash/git`: `sqliteGitStorage`, `JustGitBackend`, `GitStorage`, `OpenGitStorage`, `Registry`, `RegistryRow`. Renamed there: `gitBackend` is `justGitBackend`, and `GitBackendOptions` is `JustGitBackendOptions`                                   |
| `@ambionframework/git`       | Moved to `@ambionframework/workspace/git`: `fromDirectory`, `TemplateFiles`, `TemplateRegistration`, `TemplateSource`                                                                                                                                                            |
| `@ambionframework/git`       | Gone: `PACKAGE_NAME`                                                                                                                                                                                                                                                             |
| `@ambionframework/workspace` | Moved to `@ambionframework/just-bash/git`: `GitFetch`, `GitCredential`                                                                                                                                                                                                           |

**New entries:** `@ambionframework/just-bash/git` and
`@ambionframework/workspace/git`. The second also exports `filesOf`,
`hashesOf`, `sameFiles`, `changeTo`, `validName`, `namespaceOf`,
`assertAgent`, `readOnly`, `TEMPLATES`, and `SOURCES`.

**Stored formats that changed:** a said entry takes `after` and `owner`,
and the `returned` and `dismissed` entries are new. The journal format
stays 1. A process of a workspace keeps its files in
`~/.processes/<handle>/`.

## 0.2.0 (2026-09-24)

**A workspace now has real backends.** A shell on a remote server, a shared
SQL database, and git repositories plug into one workspace. The Pi executor
runs on Pi's AgentHarness. A seat keeps its model session for one exchange.
Every library package needs Node 22.19 or newer.

### Packages

| Package                                 | What it gives                                                     |
| --------------------------------------- | ----------------------------------------------------------------- |
| `@ambionframework/ambion`               | The kernel: room, journal vocabulary, rules, and hosting          |
| `@ambionframework/journal`              | The append-only journal                                           |
| `@ambionframework/assistant`            | The default assistant                                             |
| `@ambionframework/pi`                   | The Pi executor, on Pi's AgentHarness                             |
| `@ambionframework/claude`               | The Claude Agent SDK executor                                     |
| `@ambionframework/codex`                | The Codex SDK executor                                            |
| `@ambionframework/cloudflare`           | A room and its seats as Durable Objects                           |
| `@ambionframework/workspace`            | The workspace interface, its tools, and a SQLite backend          |
| `@ambionframework/just-bash` (new)      | A shell and a filesystem in the process, in memory or on a folder |
| `@ambionframework/workstation` (new)    | A shell over SSH on one server, with one Unix account per agent   |
| `@ambionframework/git` (new)            | Git repositories that agents fork, clone, and push                |
| `@ambionframework/cli` (retired)        | No replacement                                                    |
| `@ambionframework/pi-journal` (retired) | Pass a `logger` to the runtime to read what a seat did            |

### New

**A workspace takes one backend of each kind.** `bash` is required. `sql`
and `git` are optional, and each one adds its tools and its guidance.

```ts
import { openWorkspace } from '@ambionframework/workspace';
import { sqliteBackend } from '@ambionframework/workspace/sqlite';
import { directoryBackend } from '@ambionframework/just-bash';
import { fromDirectory, gitBackend, sqliteGitStorage } from '@ambionframework/git';

const lab = openWorkspace({
  name: 'lab',
  backend: {
    bash: directoryBackend('./data/lab'),
    sql: sqliteBackend('./data/lab.db'),
    git: gitBackend({
      storage: sqliteGitStorage('./data/lab-git.db'),
      secret: process.env.LAB_GIT_SECRET ?? '',
      templates: { report: { source: fromDirectory('./templates/report') } },
    }),
  },
  audit: {},
});
```

- **Workstation.** `workstationBackend({ host, hostKey, layout,
  credentialFor })` runs each agent's shell as its own Unix account over
  SSH. Files go over SFTP. A timeout or an abort kills the command's process
  group. See [Workstation](docs/workstation.md).
- **SQL.** The `sql` tool runs on the shared database of `backend.sql`. It
  shows the last result as a table, up to `maxRows` rows, and `export`
  writes the full result as CSV. Each agent's tables and views are visible
  to every other agent at once.
- **Git.** An agent lists templates with `repos`, forks one with `fork`,
  clones the fork into its home, and pushes with `git` in `bash`. A push
  keeps the work across a restart. See [Git](docs/git.md).
- **`git` in every just-bash shell.** It needs no configuration. The
  author of a commit is the agent's name.

**The Pi executor runs on Pi's AgentHarness.** The harness owns the model
loop, the session, and compaction. `pi({ compaction })` sets compaction.
`piExecution({ sessions, sessionDir })` keeps sessions on disk by default,
or in memory. A context overflow makes the harness compact once and send
the request again. Transient provider errors go to the room, and the room
owns every retry.

**A seat keeps its session for one exchange.** Pi, Claude, and Codex each
resume the seat's session on its next activation in the same exchange. The
first activation in an exchange starts fresh. A lost session starts fresh
from the record.

**The trace goes to your logger.** `createRuntime({ logger })` and the
Cloudflare `configure({ logger })` take a `TraceLogger`. It gets one
`TraceRecord` for each step of an activation: the room, the seat, and the
step.

**Executor authors get the room tools from the hosting entry.**
`roomTools`, `agentTools`, and `toolContext` from
`@ambionframework/ambion/hosting` hold the rules of `say`, `seat`,
`unseat`, and a definition's tools. The Pi, Claude, and Codex executors use
them.

**Conformance suites for each backend kind.** From
`@ambionframework/workspace/conformance`: `workspaceConformance` for a bash
backend, `sqlConformance` for a SQL backend, and `gitConformance` for a git
backend. The Pi executor now runs the executor conformance suite, as Claude
and Codex do.

### Fixes

- A resumed Claude activation gets the duties of its new activation, such
  as the summary duties.
- A Claude seat no longer joins the Claude Code session of its host.
- A second Cloudflare seat alarm during a live run returns at once. Before,
  it released the live run as failed.
- A journal entry of a known kind with an invalid `seq` throws. Before, the
  journal skipped it.
- A failed summary draft of another seat no longer counts against the
  summary writer.
- The audit log reports a failure to create its directory to `onError`.
- The room mirror ignores a stray file, such as `messages.jsonl.bak`,
  beside its log when it resumes.

### Breaking changes

There is no compatibility promise before 1.0.0. Some stored formats
changed, and 0.2.0 has no reader for the old ones. Start each room fresh.

- **`openWorkspace` takes `backend: { bash }`.** Import `memoryBackend` and
  `directoryBackend` from `@ambionframework/just-bash`. `WorkspaceBackend`
  is now `BashBackend`, and it names a `layout`.
- **The `sql` tool needs `backend.sql`.** Use `sqliteBackend(path)` from
  `@ambionframework/workspace/sqlite`. The tool no longer runs `sqlite3` in
  the shell, and it has no `database` or `timeout` parameter.
- **The `memory` option of `pi()`, `claude()`, and `codex()` is gone.**
- **The trace journals are gone.** Pass a `logger`. `Hosting.traces` and
  the `step`, `trace_error`, and `audit_error` events are gone.
- **The workspace change log is gone.** The audit log records every tool
  call.
- **`WorkspaceAgent` is `{ name }`, and a resource has no `destroy()`.**
- **A Codex seat with `nativeTools: 'codex'` runs with no Codex sandbox by
  default.** Run it only on an isolated host, or set `sandboxMode`.

**Removed and moved names, by entry:**

| Entry                             | Change                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@ambionframework/ambion`         | Gone: `readActivation`, `ActivationRead`, `ActivationPass`                                                                                                                                          |
| `@ambionframework/ambion/hosting` | Gone: `traceJournals`, `traceOpener`, `TraceOptions`                                                                                                                                                |
| `@ambionframework/journal`        | Gone: `scanned`                                                                                                                                                                                     |
| `@ambionframework/pi`             | Gone: `seatSessionId`                                                                                                                                                                               |
| `@ambionframework/workspace`      | Moved to `@ambionframework/just-bash`: `memoryBackend`, `directoryBackend`, `MemoryBackendFile`, `MemoryBackendOptions`, `SeedWriter`. `MemoryWorkspaceBackend` is `MemoryBashBackend` there        |
| `@ambionframework/workspace`      | Renamed: `WorkspaceBackend` is `BashBackend`                                                                                                                                                        |
| `@ambionframework/workspace`      | Root re-export gone, the entry keeps it: `openResource`, `ResourceBackend`, `ResourceEnv`, `WorkspaceAgent`, `WorkspaceResource` on `./resource`; `openSqlResource` and its types on `./sql`        |
| `@ambionframework/workspace`      | Gone: `openChangeLog`, `ChangeLog`, `ChangeLogOptions`, `ChangeQuery`, `WorkspaceChange`, `DEFAULT_CHANGE_LOG`, `SHARED_DATABASE`, `ROOM_MIRROR_GUIDANCE`, `roomMirrorPath`, `DEFAULT_ROTATE_BYTES` |
| `@ambionframework/workspace/sql`  | Gone: `SqlValue`. Import it from the root entry                                                                                                                                                     |

**Stored formats that changed:** the `ambion/trace` and `ambion/pi-session`
journals are gone. The `session` of an ended lease names the session of the
exchange. A Cloudflare object keeps its metadata in the `ambion_metadata`
table.

## 0.1.0 (2026-09-21)

**The first release of Ambion.** Ambion is a collaboration kernel for agents and humans. A room
is a shared journal with rules for taking part. The [README](README.md) holds
the positioning, and [Technical facts](docs/technical-facts.md) holds the key
facts. [The plan](planning/next.md) names the open work.

### Packages

Every package needs Node 26.4 or newer. The ten packages release in lockstep.

- **`@ambionframework/journal`** provides the append-only journal: one queue,
  fenced by run, with conditional and idempotent appends.
- **`@ambionframework/pi-journal`** stores full Pi transcript sessions over
  the journal storage contract.
- **`@ambionframework/ambion`** provides the kernel: protocol, journal
  vocabulary, rules, room, and driver, with `/hosting` and `/testing`.
- **`@ambionframework/pi`** provides the Pi executor and the audit of each
  seat transcript.
- **`@ambionframework/claude`** provides the Claude Agent SDK executor.
- **`@ambionframework/codex`** provides the Codex SDK executor.
- **`@ambionframework/workspace`** provides the resource contract, a
  directory workspace, and a SQL resource.
- **`@ambionframework/assistant`** provides a default assistant that guides
  membership and writes closing summaries.
- **`@ambionframework/cloudflare`** runs a room and its seats as Durable
  Objects.
- **`@ambionframework/cli`** provides `ambion new` and `ambion dev`.

### Boundaries of this release

- **No total exchange budget.** Activation deadlines and retry caps bound one
  activation. Continuing contributions keep an exchange open.
- **External effects stay with the application.** Tools can act before a
  contribution commits, and the application owns effect idempotency.
- **A crash records no departure.** Hosts reconcile durable presence with
  their connections after recovery.
- **Subscriptions belong to a running host.** A reconnecting client reads
  durable messages and reacquires exchange handles.
- **A workspace gives no operating-system isolation** between agents.
- **Native timers, external event subscriptions, and scheduler ingress are
  future work.**
- **No browser-only execution and no managed service.** The journal owns no
  domain transactions and no credentials.
