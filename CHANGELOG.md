# Changelog

## Unreleased

**A Pi seat receives the seat prompt as the system prompt.** The harness
wrote the prompt after the first input, and a provider lifts only the first
message into its system field. On a model that accepts system messages in the
middle of a conversation (Claude 5 and `claude-opus-4-8`, GPT-5.4 and later
on `openai`, GPT-5.5 and later on `openai-codex`), the seat
prompt reached the model as an update item and the system field held a
generic text. A hook now moves the first prompt entry to the head of each
request. The stored session keeps its order. On Anthropic, `pi-ai` now also
sends the tool list up front and turns on its beta for tool changes in the
middle of a conversation.

**The mechanism sentence reads whole again.** The first line of the room
mechanism says "You are an agent seated in a room: a shared room with a
record." The ask line says that the speech defaults yield to the
instructions under "Your instructions", the label that the prompt uses. The
workstation guidance drops the hostname, the SSH port, and the forwarded port
sentence. The sensor tools name the hostname and the remote port when a seat
connects a sensor. No tool shows the SSH port or the forwarded URL.

**The guidance of a seat follows the review of the workbench prompts.**
The speaking policy states that a directed say wakes a participant. The
hand-off paragraph asks for one only when the roster marks the seat "named
only". The roster legend explains the marks that the roster shows. The
ask line drops the sentences that only the assistant needs. The `say` tool
states that a file path is no URI. The `schedule` tool states who the
scheduled message opens an exchange for. The assistant names attention by the marks of the
roster. The Codex seat note drops "answer with `say`, then stop" and states
that the sandbox applies to no tool the seat holds. The workspace tool line
gives no count. The audit note and the process note lose their recaps. The
shell note shortens the git list. The workbench gives the assistant its own
short instructions, states the approval of an instrument across activations,
and defines the assignment of a specialist.

**The scripted executor returns a tool error to the script.** When an own
tool of a seat throws, for example a failed `compose` call, the script reads
the message in `step.results` and the activation goes on. Before, the pass
failed as transient and the room retried it after a delay. A script that
needs a failed pass throws a `ScriptedFailure`.

**The `compose` tool is on for every Pi, Claude, and Codex seat.**
`pi()`, `claude()`, and `codex()` give a seat `compose` and `describe`, with
`quickjsRuntime()` when the options name no runtime. A seat cannot turn
the tools off. A host passes its own `compose` object to choose
`processRuntime()`, an approval hook, guidance, or limits. The Cloudflare
`configure` accepts the tools. A compose call fails in workerd with an error
that says QuickJS could not load its WebAssembly, until a compose runtime
for workerd exists. A host passes `compose: { runtime }` with a compose
runtime that the host can run.

**The `describe` tool returns the signatures that `compose` no longer lists.**
`describe({ tools })` takes a non-empty list of bindable tool names, the room
tools included. It returns their typed signatures and named types, and runs
nothing. A name outside the catalog fails the call and lists the bindable
names. The kernel reserves the name `describe` as it reserves `compose`.

**The description of `compose` holds a compact list.** It keeps the
contract, the limits, and the rejection rule. Each bindable tool appears as
`name -> Type`, where `Type` names the declared output, `string` for a tool
with no output, and `object`, `array`, or the primitive type for an output with no `$id`. The full catalog
moved to `describe`. The tool list of a full workspace seat shrinks from
about 22,100 to about 9,600 characters in every request. The workspace
outputs declare an `$id`, so the list names each type.

**A failed compose call shows the signature of the tool that it names.** The
message appends the signature of the tool of the failing nested call, and of
a tool that the code read and `uses` left out.

**`COMPOSE_GUIDANCE` is shorter.** It tells the model to call `describe` before
code that reads the fields of a result, and it drops the two code examples.

**`COMPOSE_GUIDANCE` leads with the plan.** It tells the model to plan the
tool calls first, and to make a plan of two or more calls, say included, in
one compose call. A compose call has two steps: `describe`, then `compose`.
The guidance tells the model to explore large results with compose, and to
return a count or a sample. The list of cases is gone, except the rule to
wait on each process that the code starts. The description of `compose`
names the same two uses.

**`processRuntime` names the memory limit when the child aborts.** V8 can
abort the child before it prints its out-of-memory line. A child that ends
on SIGABRT now gives the memory-limit error.

**`compose: { evaluator }` becomes `compose: { runtime }`.** A seat names
the runtime of its `compose` tool in the `runtime` field. The exports change
as follows: `Evaluator` becomes `ComposeRuntime`, `EvaluatorInput` becomes
`ComposeRuntimeInput`, `quickjsEvaluator` becomes `quickjsRuntime`,
`processEvaluator` becomes `processRuntime`, and `evaluatorConformance`
becomes `composeRuntimeConformance`.

**A compose call that reads an unbound tool names the fix.** Code that
reads `tools.<name>` for a name outside `uses` gets an error that names the
tool and the bound names. The error says to add the tool to `uses`, or that
the seat has no such tool. `ComposeRuntimeInput` gains the optional `unlisted`.
`'x' in tools` is false for an unbound name. The runtime conformance
suite requires the throw, so a runtime that does not run the shared
guest script fails it.

**A failed compose call shows the result of each completed call.** The
message gives one `result:` line under each completed call, so the model
recovers what the code started, such as process handles. One result shows
at most 4096 bytes, and all results show at most `compose.limits.bytes`.

**The workspace drops the `status` and `clone` tools.** The smallest
workspace gives nine tools, from ten. A workspace with a SQL backend and a
git backend gives twelve, from fourteen. The agent reaches the same facts
through the tools that stay.

### Assistant

**The assistant routes first and stays silent after that.** In a respond
activation its job is to get the request to the specialists who need it. To
route to a seated specialist at `named` attention, it calls `say` with `to` set
to the name of that specialist. The `seat` tool routes nothing, and the
guidance now states before the `seat` rule that a seated specialist needs `say`. A live run
showed the failure: the assistant called `seat` for two specialists that were
already seated, ended with no directed `say`, and no specialist received the
request.

For everything else the assistant calls `say` in three cases only: a
participant asks it a question, the application instructions require a
message, or it steers a forbidden action. A specialist result, report, failure,
or acknowledgment is not a question, even when it is addressed to the
assistant. The assistant sends no message about it, and the closing summary
reports it. In an earlier live run, the assistant posted a specialist result
to the person and added a wiring step that no specialist had stated.

The assistant may steer in one case: a specialist writes that it will now take
an action that the person forbade in words. Then it sends that specialist one
short directed `say` that names the constraint. A result that already
happened, a plan, a proposal, or an estimate is no such action. The guidance
states the rule once, in about the same length as before.

The workbench specialists report with a `say` that has no `to`. They answer a
question that another specialist addressed to them with a directed `say`. They
hand an artifact that a colleague continues to that colleague with a directed
`say`. A live run showed specialists that sent a result to a seat that never
asked for it. A live workbench run on a ChatGPT login checked the routing, the
refused say, and the summary.

**The `seat` tool says what to do for a seated agent.** The result for an agent
that the record already seats is now `<name> is already seated. Seating it
again does not activate it. To give it the request, call say with to set to
<name>.`

### Summaries

**A summary rests on the messages of its exchange.** The summary prompt names
those messages as the only source. Every fact, value, and recommendation must
come from a message of the exchange. A reported failure, an unknown, or a
question to the person is a fact of the exchange, and the summary reports it.
The writer adds nothing from its own knowledge. When no message after the
request reports anything, the writer ends the activation without `say`, and the
source messages stay in later prompts.

The room checks the clear case itself: when no agent said a message inside the
range of a closed exchange, the close names no summary writer and the room
assigns no summary activation. The rule is `owesSummary` in
`rules.verified.ts`. The prompt no longer says "Answer what they asked". The
assistant no longer publishes a summary for every closed exchange or a summary
that states a gap that no message reports. Its identity no longer says that
it summarizes each exchange, and now says that it routes each request.

The writer copies each value as a message states it, derives none, and keeps
the source paths and URIs that a message cites. The assistant writes no summary
when its only agent messages are its own answer to the person or its own
routing requests that no specialist answered. It also writes none when one
specialist message already answers the request in full. The summary prompt
of every writer checks this case and the empty case first. A live run showed a summary with
"9.3–10.7 mA" computed from a formula and the datasheet paths dropped.

### A refused `say` tells the model what to do

The result of a `say` that the freshness rule refuses reads `Not delivered: the
room moved while you were speaking. New on the record:`, the new lines, and
`Read it, then call say again with your message unless the new messages already
say it or make it unnecessary.` A live run showed the old advice end an
activation and lose the answer of a specialist.

### Simplification

**`wait` with one handle and `timeout: 0` reads a process.** The call does
not wait. It gives the state and the new output of the process, as `status`
did. The description of `wait` and its `timeout` parameter state this. The
behavior of `wait` on several handles does not change.

**The process note gains two lines.** Each process has a directory,
`~/.processes/<handle>/`, with its spec, its out, and its exit code when it
ends. `ls ~/.processes` lists every process that the agent started and the
workspace still keeps. `ps` stays.

**The git note teaches a clone with `bash`.** To check out a repository
without a fork, the agent takes its clone URL from `repos` and runs `git
clone <url> <path>` with `bash`. The `origin` is the source, with the push
permissions of the source. A clone of `shared/<name>` pushes back to it, and
a clone of a template or of another agent's fork is read-only. The agent
raises `wait` for a large repository. `fork` keeps its `clone` option. A
failed clone of a fork now says `Run git clone <url> <path> with bash, at a path
that does not exist yet.`

**The reminder and the state line name `wait`.** A running process reads
`Call wait with its handle, and timeout 0 to read it at once.` The reminder
of the processes and the hint of the held output of a wait on several
handles name `wait` in place of `status`.

### Breaking changes

- **Every seat has `compose` and `describe`.** The tool list and the
  guidance of every Pi, Claude, and Codex seat gain both tools.
  `ExecutorBaseOptions.compose` takes `ComposeOptions` only, and
  `assertComposeOptions` refuses `false`. The name `describe` is reserved,
  so a user tool of that name is refused. `@ambionframework/pi`,
  `@ambionframework/claude`, and `@ambionframework/codex` now depend on
  `@ambionframework/compose`.
- **The `$id` of a workspace output names its type.** `ReadResult`,
  `SqlResult`, `SnapshotResult`, `RestoreResult`, `WaitResult`,
  `WaitedResult`, `PsResult`, `ReposResult`, `ForkResult`, `ConnectResult`,
  and `ObserveResult` join `Process`, `ProcessResult`, `Truncation`, and
  `SensorSource`.
- **Replace `status` with `wait`.** Call `wait` with `handles: [handle]` and
  `timeout: 0`. The result has the same text and the same details. In a
  compose call, `tools.status` is gone, and `tools.wait` binds the same
  output.
- **Replace `clone` with `bash`.** Run `git clone <url> <path>` in `bash`,
  or call `fork` with `clone`. The `compose` binding `tools.clone` is gone.
- **Expect a new count in the tool line.** The smallest workspace names nine
  tools, and the number word starts at nine.
- **No journal body and no stored format changes.** The golden journals
  stay as they are.

## 0.6.0 (2026-10-03)

<img alt="Ambion 0.6.0: code mode and macros. A seat runs short code over its tools in one call, and a skill stores a procedure as a macro. Code mode: the compose tool runs short code over the tools of a seat, and the core checks and traces each call; the model runs a macro by name with arguments and reads one value. Declared outputs: a tool declares the shape of its details, and compose checks every result against it. Free code: short code joins tools in one call, for precision and typed chains, and the live runs measured no token saving for it. The assistant: defineAssistant takes an executor function and needs no Pi package. Also new: the twelfth package, compose, with QuickJS and child process evaluators, nested calls in the trace, and bound SQL params. Fixes: a Claude seat answers a late steer, and Camera Chat keeps a steady preview." src="docs/assets/ambion-0.6.0.png" width="800">

**0.6.0 brings code mode and macros.** The `compose` tool gives a seat code
mode: the model writes short code over the tools of the seat, and the core
runs it in one call. A skill stores a procedure as a macro, and the model
runs the macro by name with arguments. The core checks each nested call
against the schema of its tool and records it in the trace. See
[Compose](docs/compose.md) and [Macros](docs/macros.md).

**Macros are the main use of code mode.** With a macro, the model writes no
code and reads only the value that the macro returns. Free code serves
precision and chains of typed tools. The live evidence in `planning/` shows
no token saving for free code, and the docs claim none. The new package
`@ambionframework/compose` runs the code in QuickJS or in a child Node
process.

**A tool declares its output.** `defineTool` types `details` from a TypeBox
schema, and `compose` checks each result against it. The workspace tools
`sql`, `snapshot`, `bash`, `status`, `cancel`, `wait`, `ps`, and `fork`
declare theirs.

**The assistant runs on any harness.** `defineAssistant` takes an
`executor` function, and `@ambionframework/assistant` no longer depends on
`@ambionframework/pi`. The core marks a steered line with `[new]` for every
executor.

**The release fixes two defects.** A Claude seat answers a line that lands
during its final answer. Camera Chat keeps its preview frame on a refresh,
and `disconnect` leaves a link whose process ended as it is.

**No journal body and no stored format changes.** A journal of 0.5.0 opens
on 0.6.0. The breaking changes are in the TypeScript API. See
[Breaking changes](#breaking-changes).

### Packages

**The eleven packages of 0.5.0 ship at 0.6.0, and one package joins.**
`@ambionframework/compose` is the twelfth publishable package. The examples
`examples/workbench` and `examples/camera-chat` stay private. Every library
package needs Node 22.19 or newer. `processEvaluator` needs Node 26 or newer.

- **Compose.** `@ambionframework/compose` has one entry point,
  `@ambionframework/compose/runtime`, and no root export. It exports
  `quickjsEvaluator` and `processEvaluator`. It depends on
  `@ambionframework/ambion` and on `quickjs-emscripten` 0.32.0, pinned
  exactly.
- **Assistant.** `@ambionframework/assistant` drops `@ambionframework/pi`
  from its dependencies and depends on `@ambionframework/ambion` only. Its
  tests take `@ambionframework/pi`, `@ambionframework/claude`, and
  `@ambionframework/codex` as development dependencies.
- **Entry points.** No other package adds or removes an entry point. No
  other package changes a dependency.

### New

#### Compose

**The `compose` option adds the `compose` tool.** `describeExecutor`
appends the tool after the tools and the bundles, and the guidance of the
tool follows the guidance of the bundles. The tool checks `uses`, asks
`approve`, and runs the code in the evaluator of the option, within four
limits. A failed or cancelled compose call throws, and its message renders
the error and the ledger. A tool named `compose` in a hand-built executor
stays an ordinary tool. A definition refuses a user tool named `compose`.

**The executor options take `compose`.** The main entry exports the types
`ComposeOptions`, `ComposeLimits`, `ComposeResult`, `LedgerEntry`,
`Evaluator`, `EvaluatorInput`, and `JsonValue`. `COMPOSE_GUIDANCE` is the
export of the guidance text, and `ComposeOptions.guidance` replaces it.

**`COMPOSE_GUIDANCE` makes compose the default for a plan of two or more
tool calls.** The live evidence showed that no seat chose `compose` for a
two-step chain. The text now tells the model to plan the calls first and to
make a plan of two or more calls in one compose call. A direct call is for
a step that needs the judgment of the model when the task gives no rule. An
example shows a query that feeds a snapshot. A paragraph tells the model to
run a macro when a skill names one. A seat with macros also gets one
guidance block after the text, with one line for each macro: the name and
the description.

**The core records the steps of a nested call.** The step vocabulary gains
the `approval` step, which records the answer of `approve`. The `tool_call`
and `tool_result` steps gain `parent`, the id of the compose call. The
hosting export `invokeTool` runs one direct call and hands the step sink of
the activation to the `compose` tool, and to no other tool. `invokeChecked`
does the same for a harness that prepared and checked the arguments, as Pi
does. `callId` skips a step with a `parent`. The scripted executor gives
each tool call a signal and the deadline.

**The tool context names a compose call.** `ToolContext` gains
`composeCall`. `ToolContext` has no `record`: no tool can write a step.

**The `approve` request is a union.** `ComposeOptions.approve` reads a
`ComposeRequest`: `{ uses, code }` for free code, and
`{ macro, hash, args }` for a macro. A host can allow its own macros and
deny free code.

#### Skill macros

**A skill stores a compose program that the model runs by name.**
`loadSkills` reads each `<skill>/macros/<name>.js`: a `/*---` YAML header
with `description`, `uses`, and `args` (a JSON Schema), and then the body.
It refuses a bad header, a bad `uses`, an `args` schema that the check
cannot read, and a bad file name, with the error `Skill set:` and the
path. `SkillSet` gains `macros`.

**`ToolBundle` gains `macros`.** The field holds `ComposeMacro` values: the
name `<skill>/<macro>`, the description, `uses`, the `args` schema, the
code, and the git blob hash of the file. `workspace.tools({ skills })` puts
the macros of the set on its bundle. The main entry exports the types
`ComposeMacro` and `ComposeRequest` and the new value `composeMacro`, which
checks the fields of a macro and gives a frozen copy.

**`describeExecutor` checks the macros of a seat with `compose`.** It
refuses a macro that names a tool of no catalog entry, one with
`compose: false` included, and two macros of one name. The error is an
`AmbionError` with the code `invalid_tool`. A seat without `compose`
ignores the macros.

**The compose arguments take a macro.** The call is `{ uses, code }` or
`{ macro, args? }`. The schema of the tool is one object with four optional
fields, because a provider accepts no `anyOf` at the top of a tool schema.
`compose` looks the macro up in the frozen set of the definition, and never
reads `~/.skills`. It checks `args` against the schema of the macro, and
takes absent `args` as `{}`. A mismatch, an unknown macro, and a mixed call
are refusals with no ledger.

**`EvaluatorInput` gains `args`.** The evaluator gives the code of a macro
the global `args`. Free code has none. The test evaluator of the core
defines it.

#### Declared outputs

**A tool can declare its output for `compose`.** `AmbionTool` gains the
field `compose`: `false`, or `{ output }` with a TypeBox schema. The check
of a tool refuses any other value. `captureTool` copies the field.

**`defineTool` has two overloads.** With `compose: { output }`, `execute`
must return a `ToolResult` whose `details` is `Static` of the schema.
`ToolResult` takes the type of its details. The new types
`BaseToolOptions`, `PlainToolOptions`, and `DeclaredToolOptions` replace
the export `DefineToolOptions`.

**`sql`, `snapshot`, `bash`, `status`, `cancel`, `wait`, `ps`, and `fork`
declare their outputs.** Each tool sets `compose: { output }` with a
TypeBox schema, and its details type is `Static` of that schema. `compose`
checks every result against the schema.

**The `sql` details change.** `rows` becomes `count`: the count of every
row of the last statement. `rows` now holds the preview rows, up to the
limit `rows`, and `columns` names the columns. A blob is lowercase hex, a
`bigint` is decimal text, and a number that is not finite is its text.
`database`, `export`, `import`, and `imported` stay.

**`wait` declares one union.** A `wait` on one handle gives the details of
`status`. A `wait` on several handles gives `processes` and `ended`.

**`sql` gains `params`.** The optional array binds text, numbers, and
`null` to the `?` placeholders of one statement. A whole number binds as an
integer. `SqlRunOptions` gains `params`, and the SQLite backend binds the
values and fails a run that has `params` and more than one statement. The
type `SqlParam` is new.

#### Evaluators

**The new package `@ambionframework/compose` holds two evaluators.**
`quickjsEvaluator()` runs the code of a compose call in QuickJS, on the
synchronous build, in the host process. It gives each evaluation a runtime and
a WebAssembly memory of its own, a memory limit, and a CPU limit.
`processEvaluator()` runs the code in a `node:vm` context in a child Node
process under `--permission` with no allow flag. It needs `--allow-net`, so it
throws at construction on Node 22. The child entry is a bundled file that
imports only `node:` built-ins. Both evaluators apply one globals table and
pass one conformance suite.

**`@ambionframework/ambion/conformance` exports `evaluatorConformance`.**
The suite covers the globals table, the JSON at each crossing, errors with
`details`, parallel calls, a memory limit, and a cut. It takes a function
that returns a fresh evaluator.

#### The assistant

**`defineAssistant` takes a required `executor` function.** The function
receives `AssistantParts` (`instructions`, `tools`, and `bundles`) and
returns an executor of any package. The options `model` and `thinking` are
gone. Pass them to the executor in the function: `executor: (parts) =>
pi({ ...parts, model, thinking })`. The package exports the new type
`AssistantParts`.

**`@ambionframework/assistant` no longer depends on `@ambionframework/pi`.**
It depends on `@ambionframework/ambion` only.

### Simplification

**The sensor response has one check.** The sensor client checks the response
schema and each file digest once. The retention trusts the client result. It
still refuses a referenced file that is missing and a received file that no
observation references.

**The process tools derive their details.** `process-tools` no longer
declares `ProcessDetails`, `WaitDetails`, and `PsDetails` by hand. They
derive from the output schemas.

**The skill text rules have one home.** The helper `skill-text.ts` holds
the text rules that `skills.ts` and the new `skill-macros.ts` share.

**One function runs each tool call.** A direct call and a nested call go
through the same function. It prepares the arguments, checks the full
schema, invokes the tool, and records the steps of a nested call.

**The executor packages name their definition file `execution.ts`.** The
file held `compose.ts` before. The public exports do not change.

### Fixes

**A Claude seat answers a line steered during its final answer.** The
Claude executable runs such a line as a turn of its own after the first
`result`. The executor parked that result behind the echo grace of 5 s, and
the echo of the line did not cancel the timer. The pass settled on the first
result, and the close stopped the turn that answers the line. Now an echo
that arrives while a result that did not fail waits on the timer cancels
the timer. The pass settles on the result of the next turn, and the say of
that turn commits after the line. A failed result keeps its timer for the
standard error.

**The core adds the `[new]` marker to a steered line.** The runner marks the
line with the prefix of `renderDelta`. Pi no longer adds its own prefix.
Codex and Claude now send the marked line.

**A direct call checks the full schema.** A direct call on Claude, Codex,
and the scripted executor now checks the arguments against the schema after
`prepareArguments`. A hand-built tool whose `invoke` checks nothing no
longer gets bad arguments. Pi keeps the check of its harness.

**`disconnect` leaves a link whose process ended as it is.** The link stays
unavailable. Before, `disconnect` relabelled it as disconnected.

**Camera Chat keeps its preview frame.** On a refresh of the same sensor
the preview keeps its frame, where it blanked for one poll. It skips the
download of a frame with an unchanged digest. The host no longer tells the
agent to edit and push `fps=5` on every connect. The camera template
accepts `--framerate`. Both READMEs state the CPU cost, the frame size, and
the 24 hour `bash` timeout that the host passes. The README states that the
login in `auth.json` decides billing.

### Breaking changes

#### What to change

**Each bullet names an action.**

- **Pass an `executor` function to `defineAssistant`.** There is no Pi
  default. Write `executor: (parts) => pi({ ...parts, model })`, or use
  `codex` or `claude` in place of `pi`.
- **Move `model` and `thinking` into the executor call.**
  `DefineAssistantOptions` no longer holds them.
- **Install the executor package yourself.** `@ambionframework/assistant`
  no longer pulls in `@ambionframework/pi`.
- **Replace `DefineToolOptions`.** Use `PlainToolOptions` for a tool with no
  declared output, `DeclaredToolOptions` for a tool with `compose: {
  output }`, and `BaseToolOptions` for the shared fields.
- **Read the new `sql` details.** `rows` was the count of rows. It is the
  preview rows now, and `count` holds the count.
- **Handle the `approval` step.** A switch over `Step` meets it, and it
  carries the `answer` of a compose call.
- **Handle `parent` on `tool_call` and `tool_result`.** A nested call has
  it, and a direct call does not.
- **Remove a `[new]` prefix that your executor adds.** The core adds it to
  each steered line.
- **Expect a checked direct call.** A tool whose `invoke` assumed unchecked
  arguments now meets the full schema check on Claude, Codex, and the
  scripted executor.

#### Journal and stored data

**No journal body and no stored format changes.** The golden journals, the
snapshot manifest, and the sensor wire API stay as they are. A journal of
0.5.0 opens on 0.6.0. The new `approval` step belongs to the trace. No
journal body carries a step.

#### Exports

- **`@ambionframework/ambion`.** Adds `composeMacro`, `COMPOSE_GUIDANCE`, and
  the types `BaseToolOptions`, `PlainToolOptions`, `DeclaredToolOptions`,
  `ComposeLimits`, `ComposeMacro`, `ComposeOptions`, `ComposeRequest`,
  `ComposeResult`, `Evaluator`, `EvaluatorInput`, `JsonValue`, and
  `LedgerEntry`. Removes the type `DefineToolOptions`.
- **`@ambionframework/ambion/hosting`.** Adds `invokeTool` and
  `invokeChecked`.
- **`@ambionframework/ambion/conformance`.** Adds `evaluatorConformance`.
- **`@ambionframework/workspace`.** Adds the type `SqlParam`.
- **`@ambionframework/assistant`.** Adds the type `AssistantParts`.
- **`@ambionframework/compose`.** Is a new package with the entry
  `@ambionframework/compose/runtime`: `quickjsEvaluator`, `processEvaluator`,
  and their option types.
- **The other entries keep their exports.**

## 0.5.0 (2026-10-02)

<img alt="Ambion 0.5.0, six things new in this release. Sensors: an agent forks a sensor template, commits it, runs it, and observes through it, and each observation is kept as evidence. Actuators: an actuator is a controller command that the agent starts with bash, and exit 0 means the device is safe. Isolation: Claude, Codex, and Pi seats have no native tools, and files and a shell come only through the workspace. Camera Chat on macOS: an agent forks a camera sensor, launches it, and looks through it with a live preview. Codex runs on app-server, with turn/start, turn/steer, and turn/interrupt. Pi runs on Pi 1.0, on a Claude or ChatGPT subscription. Also new: a clone tool, JSON as the one data rule, a session trace step, steer with a receipt, and one word for each meaning." src="docs/assets/ambion-0.5.0.png" width="800">

**0.5.0 gives sensors a Git-template lifecycle.** The agent forks a
template, customizes it, validates it, commits, and pushes. It runs the saved
version as a workstation process, connects to it, and observes it. Each
observation lands in the snapshots as retained evidence. The agent rolls back
with the Git and process tools. See [Sensors](docs/sensors.md).

**The workspace owns its port.** `@ambionframework/workspace`,
`@ambionframework/workstation`, and `@ambionframework/just-bash` import no
Pi package. A host with Claude or Codex seats installs no Pi package to use
a workspace.

**The layer boundaries hold by rule and by test.** An import rule refuses
each import that the layers do not allow, and a rule that matches nothing
fails a test. See [Toolchain](docs/toolchain.md).

**Each word of the vocabulary has one meaning.** The release renames
exports, stored fields, and the text that a model reads. No old name stays as
an alias. The section [The vocabulary](#the-vocabulary) lists each change.

**The executors changed.** A Claude seat is hermetic and reaches files and a
shell only through the workspace tools. A Codex seat runs on `codex
app-server` and takes a steer. The Pi executor runs on
`@earendil-works/pi-durable` 1.0.0.

**No journal of 0.4.0 opens on 0.5.0.** Stored bodies change field names, and
the kernel reads only the format that its release writes. The section
[Journal and stored data](#journal-and-stored-data) lists the changes.
Ambion supports no downgrade before 1.0.0.

### Packages

**The eleven packages of 0.4.0 ship at 0.5.0.** No package joins or leaves.
The sensor work adds no sensors package. `examples/workbench` stays
private, and the new example `examples/camera-chat` is private too. Every
library package needs Node 22.19 or newer.

- **Entry points.** `@ambionframework/workspace` adds the `./sensors` entry
  and the `./sensor-api.schema.json` file. No other package adds or removes
  an entry point.
- **Pi.** `@ambionframework/pi` drops `@earendil-works/pi-agent-core`. It
  depends on `@earendil-works/pi-durable` 1.0.0, pinned exactly, on
  `@earendil-works/chord` `^1.0.0`, and on `@earendil-works/pi-ai` `^1.0.0`.
  Every other package that names `pi-ai` takes `^1.0.0`.
- **Codex.** `@ambionframework/codex` drops `@openai/codex-sdk` and
  `@modelcontextprotocol/sdk`. It depends on `@openai/codex` 0.159.2.
- **`pi-agent-core`.** `@ambionframework/ambion`,
  `@ambionframework/cloudflare`, `@ambionframework/workspace`,
  `@ambionframework/workstation`, and `@ambionframework/just-bash` drop
  `@earendil-works/pi-agent-core`.
- **Claude.** `@ambionframework/claude` depends on
  `@anthropic-ai/claude-agent-sdk` 0.3.284.
- **Just-bash.** `@ambionframework/just-bash` pins `just-git` to exactly
  1.8.2.
- **Workspace.** `@ambionframework/workspace` depends on `diff` for the
  `edit` patch.

### New

#### Sensors

**Sensor connections expose host lifecycle callbacks and a disconnect tool.**
A workspace with endpoints exposes `workspace.sensors.get`, `list`, and
`subscribe`. The workspace root exports the types `SensorDiscovery`,
`RegisteredSensorConnection`, and `SensorConnectionEvent`. An event has the
`type` `connected`, `refreshed`, `disconnected`, or `unavailable`. Events
report committed connection, refresh, disconnect, and
process-unavailability changes. Listener failures do not undo registry changes.
`disconnect({ name })` detaches an owned link and closes its transport without
stopping its process; `cancel` remains responsible for acquisition lifetime.

**Camera Chat runs an agent-owned camera template on macOS.** The agent can
fork and clone the supplied template, launch it through Bash, and use standard
`connect` and `observe`. A successful connection opens a small native-image
preview above a Workbench-style transcript. Disconnect or process exit hides
it. Retained observation images render inline beneath the messages that cite
them, at the preview size. The seat runs on the Codex executor and reuses the
Codex login of the host: it needs no API key, and startup exits with an
instruction to run `codex login` when the host has no login. The default model
is `gpt-5.6-luna` at medium reasoning, and `--model` selects another. The demo
runs a script in place of Codex and exercises the same lifecycle with
synthetic frames.

**A workspace with endpoints can observe and retain sensor evidence.** The
`observe({ sensor, span? })` tool reads one connected sensor, fetches and
verifies every referenced file, and stores the full response and file refs in
the existing snapshot object store before returning. The result includes
measurement values and times, export paths, and a manifest snapshot ref.
`observe` retains frame bytes in its exports and snapshots, and each result
states the path of a frame in text.

**Every workspace tool bundle carries image parts.** Every executor kind
carries image parts, so a workspace has one tool bundle. `observe` returns
each frame as an image part, and `read` of an image returns the image part.
Each result also states the path of the image in text: the export path in
`observe`, and `Image path: <path>` in `read`. A model that cannot read
images still learns where the file is.

**A workspace with endpoints connects running sensor servers.** The
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
root exports `WorkspaceEndpoint` and `WorkspaceEndpoints`, and `BashBackend`
accepts the optional `endpoints` capability. `workstationBackend` forwards a
remote `127.0.0.1` service port to an automatically assigned host loopback port.
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
template imports the workspace schemas from a workspace package that the
agent builds and packs from a pinned commit. Its README
documents its setup, customization, validation, process lifecycle, data
retention, and rollback. The Workbench lifecycle test runs the sensor conformance
cases against a fresh clone.

#### Git, processes, and actuators

**A `clone` tool checks out a repository with no fork.**
`clone({ source, path })` in the optional Git tool bundle checks out a
registered template or an agent repository into `path`. It creates no
server-side fork. `origin` stays the source, with the push permissions that
the source already has. The tool resolves the source on the git owner, and it
clones on the shell owner. `fork` does not change. A workspace with a git
backend has the tools `repos`, `clone`, and `fork`. See
[Git](docs/git.md).

**An actuator is a controller command that an agent starts with `bash`.**
Ambion adds no actuator tool, API, or server. The agent reads the command
with `status` and stops it with `cancel`. [Actuators](docs/actuators.md)
states the pattern and a controller contract of seven rules: a command
handles `TERM` first, and exit code 0 means that the device is safe. The
template `examples/workbench/templates/actuator-controller` is a Node
controller over a simulated plant. Its tests send real signals, and a
Workbench test guards them.

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

**`bash` takes a `grace` for each call.** The new optional parameter `grace`
is a number of seconds from 1 to 300, 10 by default. A value outside the
range fails the call with `Invalid`. The table writes `grace` to `spec`,
so an adopted process keeps the grace of its own call. A `spec` with no
`grace` is no spec: a read skips it. `Process` gains
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
a grace outside 0 to 2,147,483 seconds. `Process` gains `stopping`,
which is `true` while a process that the table stopped still runs. The
workstation's command script adds `trap : TERM`. A channel that a signal
ends now reports 128 plus the signal number: before, `ssh2`'s `SIG`
prefix gave 128. No journal body changes.

**`dispose()` stops the processes of one agent at the same time.** Before,
an agent with 4 processes that ignore `SIGTERM` took about 60 seconds to
stop. Now the processes of this run stop in about one grace and 5 seconds.
An adopted process takes one chain step for each signal, and waits for the
end outside the chain.

#### Executors

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

**A Claude query passes a settings overlay.** The flag tier turns auto-memory
off and empties the commit, pull request, and session-link attribution.
`settingSources` stays empty, and the query passes `skills: []`. The executor
also sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, which holds before any
settings tier, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. A managed
`attribution` can still add text.

**A failed Claude pass carries the end of the process stderr.** Every failed
pass adds the last 2,000 characters of the stderr to the message. This holds
for a failed result, a query that ends early, and a query that throws. A
failed result waits 50 milliseconds for the stderr, and it settles at once
when the process ends or `close` runs. The failure class still comes from the
result or the original error.

**A Codex seat takes a steer.** A line that lands during a turn goes in with
`turn/steer`. The core records the `steer` step with `consumed: true` when
Codex echoes the line. Codex refuses a steer after the turn ends, and the
next pass then carries the line. A cut sends `turn/interrupt`.

**The Codex executor records the `session` step.** It holds the version of
the binary, the model, the working directory, the thread id, the sign-in
kind from `account/read`, the permission mode, the bound tool names, and the
MCP servers. Freshness rests on the echo of each input. Usage comes from `thread/tokenUsage/updated`.

**A Codex resume counts no earlier usage.** The executor sends
`excludeTurns: true` with `thread/resume`, and it drops a
`thread/tokenUsage/updated` note whose turn is not the running turn. A login
that gets no answer in 30 seconds fails as transient.

**A resumed Codex thread keeps its tools.** The executor resumes a thread
only when the tools in its rollout file equal the bound tools. Otherwise,
and when `thread/resume` fails, it starts a fresh thread and records the
`notice` "Codex thread not resumed". A resumed thread takes the new seat
text from `baseInstructions`, and its first prompt holds the view alone. A
process that exits during a pass is a transient failure that holds
the stderr tail.

**An image from a tool reaches a Codex seat.** The catalog patch no longer
sets `input_modalities` and
`supports_image_detail_original`. The model keeps its own modalities, so a
workspace `read` of a picture and the frames of `observe` reach it as images.
The tool list does not change, because `view_image` stays off. A model with
no image input stays text-only, and Codex shows a placeholder.

**The Codex package tests the real `codex app-server` on a scripted model.**
`codex` accepts a custom model provider through its config. A local endpoint
in `packages/codex/test/responses.ts` speaks the Responses API and plays a
script of replies. `test/binary.test.ts` runs the bundled binary against it,
in a temporary Codex home, with a minimal environment. It proves that a seat
speaks through `say`, that the activation reports the usage of the endpoint,
that the model sees the room tools and the tools of the seat and no native
tool, and that a second pass resumes the same thread. This tier runs in the
unit tier and needs no key.

#### Trace output

**The trace has a `session` step.** It records what the vendor session opened with.
`Step` gains
`{ type: 'session'; name; version?; model?; cwd?; session?; auth?;
permissionMode?; tools; servers }`.
The Claude executor records one for each `system` init message. `tools` holds
the room tools by plain name. `servers` holds each MCP server with its
status. `auth` names the source of the credential. Pi records none. The Codex
executor records one when a thread opens.

**A Codex activation shows its reasoning and diagnostics in the trace.**
Codex shows no reasoning unless the request asks for a summary, and the
catalog of some models turns the summary off. The new option
`reasoningSummary` of `codex()` takes `auto`, `concise`, `detailed`, or
`none`. The default is `auto`. The executor passes it as
`model_reasoning_summary`, and the summary arrives as `thinking` steps. The
default trace policy keeps 280 characters of each thinking block.
`defineAgent({ trace: { thinking: 'full', toolOutput: 'full' } })` keeps all
of it.

**A Codex trace names the thread and the rollout file.** The executor
records one `notice` at level `info`, with the text "Codex thread", for each
thread of an activation. Its `data` holds the `thread` id, the `home` of the
seat, and the `rollout` path, `<home>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`.
Codex writes the instructions, every item, the reasoning, and the tool calls
there. The binary tier proves the path and the notice.

### Simplification

**The workspace implements its own file tools.** `read`, `write`, and
`edit` run over the workspace port in place of the factories of Pi. They keep
the names, the parameters, and the results of the Pi tools. A `read` of a BMP file
tells the model to convert the file with bash. A workspace tool
is a core `AmbionTool`, so the workspace needs no wrapper for a Pi tool.
The workspace copies the truncation helpers, the shell output update, and
the skill list that it used from Pi. It depends on `diff` for the `edit`
patch. No export changes.

**The body schemas are the one source of the body types.** The new file
`packages/ambion/src/bodies.ts` holds the schema of each stored body.
Before, a type and a schema each stated the body, and the two drifted.
`SaidMessage`, `PostedMessage`, `PresenceMessage`, `SummaryMessage`,
`DismissedMessage`, `PresenceChange`, `Attention`, `EndReason`,
`FailureCause`, `Usage`, `VendorSession`, `Lease`, `Close`,
`Cancel`, `Run`, `Seating`, and `Composition` now derive from the
schemas with `Static`.

**Each derived type keeps its name and its fields.** The fields, the
optional keys, and the `readonly` marks stay the same. An interface stays an
interface, and an alias stays an alias. The `.d.ts` of a type refers to its
schema, and the schema carries the doc comment of each field.

**The release request takes its fields from the ended lease.** The
`release` variant of `LeaseRequest` takes `reason`, `readThrough`, `cause`,
`usage`, and `session` from the schema of the ended lease. It lists them
once.

**`addUsage` joins the main entry.** `@ambionframework/ambion` exports
`addUsage(total, step)`, which adds a step to a total, which may be absent.
The core already held this function. The Pi executor held a second copy as
`sum`. The simulator held a third as `total`. Both now call `addUsage`.

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

**`@ambionframework/workspace` exports `MAX_TIMER_SECONDS`.**
The constant is 2,147,483, the most seconds that a Node timer holds. The
bash timeout, the SQLite timeout, the process table, and the workstation
checks of `idleTimeout`, `timeout`, and `grace` read this one value. No
limit changes, and no message changes.

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
`RunningActivation` only delivers the line. The core calls it at any moment
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

### Fixes

**The ended lease refuses an invalid `cause`.** The schema of an ended lease
did not name `cause`, so any value passed. The schema now holds `permanent`
or `transient`. A journal that holds another value stops at replay with an
error that names `body.cause`.

**The Codex recipe matches `codex` 0.159.2.** `exclusiveConfig` no longer
sets `tools.view_image`. Codex does not know the key, and it reported two
warnings for every run. The `view_image` feature still turns the
tool off. The config sets `skills.include_instructions` and
`skills.bundled.enabled` to `false`, so no `skills_instructions` message
reaches the model and Codex installs no system skill in the seat home. The
catalog flag `include_skills_usage_instructions` did not remove that message.
The config also sets `check_for_update_on_startup`, `analytics.enabled`,
`feedback.enabled`, `memories.generate_memories`, and
`memories.use_memories` to `false`, so a seat sends no analytics or
feedback and keeps no memory. `codex app-server` starts no update check, and
the update key keeps it so on a later version. `EXCLUSIVE_FEATURES` gains
`shell_snapshot`, `daemon_auto_start`,
`workspace_dependencies`, `worktrees`, `realtime_conversation`, and
`memories`. Each acts on the host or the network, or writes state outside
the journal. `shell_snapshot` ran the shell of the host
user and wrote its environment into the seat home. The binary tier now
asserts that a default seat produces no warning `notice` and no skills
block. The catalog fixture is `catalog-0.159.2.json`. Docs state that the `config.toml` of
the seat home is the responsibility of the host, because a key that the
recipe does not name survives from it.

**The trace logs the size of an image in a tool result of every executor.**
`loggedToolResult` replaced the bytes of an image with their count only in
the `content` array of a record. The Claude and Codex executors log the
content parts with no record, so their images went into the log whole. The
function now takes the array as well, and an image in the shape of the
Anthropic API, with its bytes in `source.data`.

**A Codex seat has the room tools on its first model request.** The room
tools are dynamic tools of the thread, so the first request lists them. In
0.4.0 Codex started an MCP server in the background and waited one second
for it. A loaded host started the room tools server in more time, so the
first request listed no room tool. A real model could not call `say` on that
request and could answer in text that the room never hears. The binary tier
asserts that every request lists the room tools.

**A Codex seat stops when its host dies.** `codex app-server` reads the input
of the host. When the host dies, the OS closes the pipe and the process ends.
In 0.4.0 a host that died by SIGKILL or out of memory left the Codex process
running, with the model request in flight, and the process spent on the model
until its turn ended. A test kills a real host in the middle of a model
request and proves that the process goes away within seconds.

### Breaking changes

#### What to change

**Each bullet names an action. The section that it links holds the detail.**

- **Rename every old name.** Use the tables in
  [The vocabulary](#the-vocabulary). The `schedule` tool takes
  `delaySeconds`.
- **Start from a new journal.** No journal of 0.4.0 opens. See
  [Journal and stored data](#journal-and-stored-data).
- **Append JSON bodies only.** A `Date`, a `bigint`, and a field that holds
  `undefined` fail at `append`. Replace `CloneableJournal` with `Journal`, and
  `assertWire` with `assertJson`.
- **Start a Cloudflare room with no `name`.** `StartOptions.name` is gone,
  and `RoomMetadata` and `SeatMetadata` lose fields. See
  [Journal and stored data](#journal-and-stored-data).
- **Move the Pi `compaction` option to a Pi `CompactionPolicy`.** Set
  `compaction.enabled` for overflow recovery. A session of 0.4.0 does not
  open, and a seat starts a fresh one. See [The Pi executor](#the-pi-executor).
- **Remove the Claude policy options that grant tools.** `permissionMode`,
  `allowedTools`, `disallowedTools`, `canUseTool`, `cwd`, and
  `additionalDirectories` are gone. Give the seat the workspace tools in
  `bundles`.
- **Sign a Claude seat in with a key or a token.** `claude login` cannot
  reach a seat. Pass `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, and set
  `claudeExecution({ configRoot })` to keep sessions across a restart. See
  [The Claude executor](#the-claude-executor).
- **Pass only additions in the Claude `env` option.** A host on Bedrock,
  Vertex, or Foundry passes the variables that its provider needs.
- **Use a Claude executable 2.1.248 or newer.** An older one fails the pass
  as permanent.
- **Drop the Codex SDK and the room tools server.** The executor runs on
  `@openai/codex` 0.159.2 and `codex app-server`. See
  [The Codex executor](#the-codex-executor).
- **Sign a Codex seat in again.** With `CODEX_API_KEY`, the executor signs in
  through `account/login/start`. Otherwise link a file login, because a
  keyring login cannot be shared. Seats no longer read `~/.codex`, and a
  thread in `~/.codex/sessions` starts fresh. Pass `home` to place the seat
  home.
- **Remove the Codex options that grant native tools.** `nativeTools`, the
  policy options, and `skipGitRepoCheck` are gone. Use the workspace tools in
  `bundles`. `env` now lays over an allowlist.
- **Read the Codex seat text as instructions.** It is the `baseInstructions`
  of the thread. The first user message holds the view alone.
- **Handle the `notice` step, and drop the `approval` step.** See
  [The trace](#the-trace).
- **Implement the workspace port with an `AbortSignal`.** Every member takes
  `signal?: AbortSignal`. `BACKGROUND_CONTEXT`, `TMP`, `tempDirPath`, and
  `tempFilePath` are gone. See [The workspace](#the-workspace).
- **Pass `git` to the bash backend.** `memoryBackend`, `directoryBackend`, and
  `WorkstationOptions` take a git backend of their own package.
  `GitConformanceStore.bash` is a function.
- **Rename `audit: { maxBytes }` to `audit: { rotateBytes }`.**
- **Rename `TemplateRegistration` to `RepositoryRegistration`.** `shared` is a
  reserved agent name.
- **Read pending says from the room read.** Use `awaitingFor(read, person)`
  and `read.scheduled`. `Room.pendingFor`, `Room.scheduled`, and
  `RoomObject.scheduledSays` are gone.
- **Update executor and hosting imports.** Names left the hosting entry,
  `ActivationOpener` is a function of the activation, `Executor` names the
  value in a definition, `ExecutionServices` holds three fields, and
  `createPiExecutor`, `createClaudeExecutor`, and `createCodexExecutor` are
  gone. See [The core exports and tests](#the-core-exports-and-tests).
- **Update tests that script a room.** `Turn` is `Reply`, and the verbs come
  from `@ambionframework/ambion/testing`. The conformance fixture types are
  one `ConformanceFixture`.

#### The vocabulary

**Breaking: each word of the vocabulary has one meaning.** A rename pass
gave each overloaded term one meaning. The glossary in `docs/room.md` lists
the terms, and `scripts/vocabulary.test.mjs` refuses the old names in
`pnpm check`. No old name stays as an alias. The kernel does not read a
journal of an earlier release.

The entry body types in `journal/entries.ts` match their kind: `Fence` is
`Run`, `Cancellation` is `Cancel`, and `LeaseChange` is `Lease`. The
journal package names its write `append` in prose, and `positionOf` is
`seqOf`.

Stored bodies change field names. The golden journals hold the new names.

The glossary now defines record, reconcile, from, commit, presence message,
and driver. "The driver" replaces "the core" for the code that runs an
activation.

| Body           | Before                           | After                                |
| -------------- | -------------------------------- | ------------------------------------ |
| `said` message | `after`                          | `delaySeconds`                       |
| Any message    | `activationId`                   | `activation`                         |
| Ended `lease`  | `session: { harness, id }`       | `session: { kind, id }`              |
| `composition`  | `agents`, `available`, `summary` | `seated`, `reserve`, `summaryWriter` |
| `close`        | `summary`                        | `summaryWriter`                      |

The text that a model reads changes in six places. Live cases on Pi,
Claude, and Codex pass on the new text.

- The prompts and the tool results of `say` say "activation" where they said
  "turn". The prompt for a respond activation says "Begin your activation".
- The prompts and the assistant guidance say "respond activation" and
  "summary assignment" where they said "ordinary work", "ordinary
  activation", and "closing assignment".
- The `schedule` tool takes `delaySeconds` where it took `after`, and the two
  process texts that name the tool follow.
- The `schedule` tool text says "the person of the current exchange" where
  it said "the person who owns the current exchange".
- The prompt for a respond activation says "seating operations" where it
  said "membership operations". The assistant guidance says "seating" where
  it said "membership".
- The identity of the judge says "Grades a simulation against its criteria"
  where it said "Grades a run".

The exported names change as follows.

| Area                    | Before                                                                                                                           | After                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Executor                | `AgentExecutor`, `AgentExecutorBaseOptions`                                                                                      | `Executor`, `ExecutorBaseOptions`                                                                           |
| Executor (hosting)      | the function type `Executor`, `ExecutorSession`, `AgentExecutionContext.executor`                                                | `ActivationOpener`, `RunningActivation`, `opener`                                                           |
| Events                  | `ExecutionEvent`; the fields `agent`, `author`, `toolName`; `tool_execution_start`, `tool_execution_end`; `activation_end.spoke` | `ActivationEvent`; `seat`, `seat`, `name`; `tool_call`, `tool_result`; `said`                               |
| Messages                | `SpokenMessage`, `isSpoken`, `RoomToolOptions.spoke`, `DEFAULT_GUIDANCE`                                                         | `SaidMessage`, `isSaid`, `said`, `DEFAULT_SPEAKING`                                                         |
| Exchanges               | `ExchangeView`, `ClosedExchange`, `ClosedExchangeView`                                                                           | `Exchange`, `ExchangeRange`, `Extract<Exchange, { readonly status: 'closed' }>`                             |
| Read positions          | `watermark`, the lease `lastSeq`, the selection `since`, the delta `since`                                                       | `through`, `through`, `after`, `after`                                                                      |
| Scheduled says          | `PendingSay`, `pendingFor`, `Intent.after`, `schedule.minAfter`, `schedule.maxAfter`                                             | `ScheduledSay`, `awaitingFor`, `delaySeconds`, `minDelaySeconds`, `maxDelaySeconds`                         |
| Activations             | the purpose `'summary'`, `ActivationOutcome.status`, `SummaryOutcome.status`                                                     | `'summarize'`, `kind`, `kind`                                                                               |
| Participants            | `ParticipantInfo`, `AgentParticipantInfo`, `HumanParticipantInfo`                                                                | `Participant`, `AgentParticipant`, `PersonParticipant`                                                      |
| People                  | `HumanDefinition`, `defineHuman`, `kind: 'human'`, `Visit.human`                                              | `PersonDefinition`, `definePerson`, `kind: 'person'`, `Visit.person`                    |
| Visitors                | the Cloudflare `Person`, `Workbench.join`                                                                                          | `Visitor`, `Workbench.visit`                                                                                |
| Ending work             | `Room.abort()`, `AgentRunner.abort()`, `ActivationState.cancel()`, `RoomToolBinding.abort()`, the stop `'aborted'`               | `Room.cancel()`, `cutAll()`, `cut()`, `cut()`, `'cut'`                                                      |
| Entries                 | the journal `JournalEntry`, the core union `Entry`                                                                               | `Entry`, `RoomEntry`                                                                                        |
| Stored-field types      | `Landed.activationId`, `HarnessSession`, `Pass.resume`, `Composition.agents`, `Composition.available`                            | `activation`, `VendorSession`, `resumeId`, `seated`, `reserve`                                              |
| Summary writer          | `summary` on `StartRoomOptions`, `Composition`, `Close`, and the Cloudflare `StartOptions`                                       | `summaryWriter`                                                                                             |
| Trace                   | `TraceRecord`, `RoomProjection.record`, `OwedFacts.record`, `TracePolicy.thinking: 'summary'`                                    | `TracedStep`, `summaryFacts`, `summaryFacts`, `'start'`                                                     |
| `/testing`              | `scriptedExecutor`, `speak`, `later`, `isClosing`, `Step`, `Call`, `Result`, the script parameter `call`                         | `scriptedOpener`, `say`, `schedule`, `isSummarizing`, `ScriptStep`, `ScriptCall`, `ScriptResult`, `request` |
| Conformance             | `ExecutorHarness`, `PortHarness`, `piExecutorHarness`, `claudeExecutorHarness`                             | `ExecutorFixture`, `PortFixture`, `piExecutorFixture`, `claudeExecutorFixture`        |
| Simulator               | `Run`, `RunExchange`, `SimulateOptions.exchanges`, `AgentActorOptions.timeoutMs`, `AgentJudgeOptions.timeoutMs`                 | `Simulation`, `SimulationExchange`, `messages`, `moveMs`, `gradeMs`                                         |
| Executor packages       | `ClaudeRuntime`, `CodexRuntime`, `ClaudeHarnessOptions`, Pi testing `scripted`, Claude `FakeScenario.turns`                      | `ClaudeExecutionOptions`, `CodexExecutionOptions`, `ClaudeFixtureOptions`, `scriptedStream`, `passes`       |
| Workspace backends      | `GitBackend.server`, `ObjectBackend.store`, `SqlBackend.database`, `Workspace.host`, `AuditLog.record`                           | `label`, `label`, `label`, `mirrorAgent`, `append`                                                          |
| Processes and keys      | `ProcessStatus`, the cancel result `stopped`, `tokenTtl`, `keyTtl`, `WorkstationOptions.host`, `WorkstationGitOptions.host`      | `Process`, `cancelled`, `credentialTtl`, `credentialTtl`, `server`, `server`                          |
| Port and send           | the event `delivery_error`, `DeliveryState`, `Limits.delivery`, `MessageDelivery`, `limits.schedule.pending` | `port_error`, `SendState`, `Limits.port`, `MessageRecipients`, `limits.schedule.waiting` |
| Cloudflare              | `RoomObject.abort()`, `StartOptions.agents`                                                                                      | `cancel()`, `definitions`                                                                                   |
| Kernel exports | `RoomTool`, `RoomToolResult`, `ToolExecutionMode`, `AgentExecutionContext`; the executor contract in `protocol.ts` | `BoundTool`, `BoundToolResult`, `ToolConcurrency`, `SeatContext`; the contract in `execution/contract.ts` |
| Workbench and live tier | `/abort`, `AMBION_HARNESS`                                                                                                       | `/cancel`, `AMBION_EXECUTOR`                                                                                |
| Room rules (internal) | `OpenWake`, `HeldWake`, `wakesOf`, `pendingOf`, `room/wakes.ts`, `Owed`, `older()`, `spokenLine`, `spoken()`, the exchange `Pass`, the fold `Step`, the transition `PresenceChange`, the reconcile `Ending`, the rules `Verdict` | `OpenRespond`, `HeldRespond`, `respondsOf`, `dueRespondsOf`, `room/responds.ts`, `DueSummarize`, `noFacts()`, `saidLine`, `isText()`, `ExchangeFacts`, `FoldStep`, `PresenceDraft`, `LeaseEnd`, `SummaryVerdict` |

#### Journal and stored data

**Breaking: JSON is the one rule of plain data.** `CloneableJournal` is removed from
`@ambionframework/journal`, with its helper types. `RoomJournal` is
`Journal<Kind, Bodies>`. The package exports `assertJson`, the one check that
a value is JSON: plain objects and arrays, finite numbers, and no `undefined`
field. `assertWire` is removed from the protocol of the core. `append` refuses
a body that is not JSON, with the path of the fault, before storage sees it.
A `Date`, a `bigint`, and a field that holds `undefined` are refused on every
storage. The memory journal copies a value through JSON, as SQLite does.

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

**The name of a Cloudflare object is its identity, and the objects keep
no second copy.** `StartOptions.name` is removed: the stub names the room,
and `RoomObject` takes the name from its id. `RoomMetadata` holds
`stopped` alone, without `name` and `agents`. A resumed room takes the
definitions of the agents on its record from `configure`. `RoomRead` gains
`reserve`, the agents that no seat holds.
`SeatMetadata` holds `activation`, `phase`, and `hold`, without `room` and
`seat`: the seat object reads both from its name, which `seatName` builds.
`SeatMetadata.wakes` and `cuts` are removed, with `SeatObject.wakes()`
and `SeatObject.cuts()`. A room object that no name reaches throws.

#### The Pi executor

**Breaking: the Pi executor runs on `@earendil-works/pi-durable` 1.0.0.**
`@ambionframework/pi` drops `@earendil-works/pi-agent-core` and its
`AgentHarness`. It depends on `@earendil-works/pi-durable` pinned to exactly
`1.0.0`, on `@earendil-works/chord` `^1.0.0`, and on `@earendil-works/pi-ai`
`^1.0.0`. Every other package that names `pi-ai` takes `^1.0.0`, and
`@ambionframework/ambion` and `@ambionframework/cloudflare` drop
`pi-agent-core`. The pin is exact because the executor reads the storage
format and the failure reasons of pi-durable. These changes break:

- **The `compaction` option.** It takes a partial Pi `CompactionPolicy` in
  place of the `CompactionSettings` of `pi-agent-core`. The harness holds the
  default, and `DEFAULT_COMPACTION_SETTINGS` is gone. `pi()` throws when a
  count is negative or not a safe integer, and when `enabled` is not a
  boolean.
- **Overflow recovery needs compaction on.** A context-overflow error fails
  the pass when `compaction.enabled` is `false`. Before, the harness
  compacted once whatever the setting.
- **The disk session format.** A session is a pi-durable JSONL storage at
  `<sessionDir>/<room>/<seat>/<id>`. A session of an earlier release does not
  open, and the activation starts a fresh one. A JSONL file with a corrupt
  line also starts a fresh session.
- **Exports.** `@ambionframework/pi` exports `StreamFn`, `NativePiTool`,
  `CreatedSession`, `CompactionOptions`, and `ThinkingLevel`. It defines them
  itself, because `pi-agent-core` no longer supplies them. `PiSessions` takes
  `create(scope, id)` and `open(scope, id)` over a pi-durable `Storage`.
- **Tool results reach the model whole.** The executor sets the output
  limits of every tool to the largest safe integer. The harness would bound
  a result to 2000 lines and 50 KiB otherwise.
- **The system prompt has no tag.** The model reads the prompt as the
  executor built it.
- **`runAgent`** keeps its session in a private memory storage and ignores
  `services.sessions`.

The executor aborts the work that a lost process left in a session before
the next submit, because a submit would resume it. A pass that failed, was
cut, or ended before a steered line leaves its entries after the last answer.
The executor omits them with one `ambion.omit` entry, and the delta gives the
model each range of the record once. A steered line that the answer outruns
reports `consumed: false`, and the next pass carries it. A storage that fails a
commit fails the pass as transient.

#### The Claude executor

**A Claude seat has no built-in tool.** This breaks a host that set a Claude
policy option. `ClaudePolicy` keeps `effort` and `maxBudgetUsd`. The options
`permissionMode`, `allowedTools`, `disallowedTools`, `canUseTool`, `cwd`, and
`additionalDirectories` are gone. The query always passes `tools: []`, an
allow list of the tools of the seat, the mode `dontAsk`, and no permission
callback. Its `cwd` is the `work` directory of the seat. A seat reaches files
and a shell only through the workspace tools of its bundles. Those tools run
behind the workspace port. The seat reaches the filesystem that the backend
serves: memory, one directory of the host, or a remote server. The executor
passes `toolAliases` for `Bash`, `Read`, `Write`, and `Edit`. Each alias goes
to the tool of the seat with the matching name. An alias redirects the name
and converts no argument.

**A Claude query is verbatim.** The query passes `verbatimPrompts: true`. The
executable read the file that an `@path` mention in a user message named. It
did this with no tool call and no permission check, from the host
filesystem. A participant of a room could pull any file of the host user into
a seat. It also ran a message that started with `/` as a slash command. Each
user message now reaches the model as written. An older executable ignores
the mark. The executor reads the version in the `system` init message and
fails the pass with a permanent failure when it is below 2.1.248. It then
closes the query, so no model turn runs.

**A Claude seat has its own config home, home directory, and environment.**
This breaks a host that relied on `claude login`. The executor sets
`CLAUDE_CONFIG_DIR`, `HOME`, and `USERPROFILE` to directories of the seat.
It does this after it reads `env`, so no option shares the config home of the
host user.
The sign-in of `claude login` cannot reach a seat. Pass `ANTHROPIC_API_KEY`,
or the token from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`.
`claudeExecution({ configRoot })` places the seat directories at
`<configRoot>/<room>/<seat>`. Without it, each seat gets a private
directory in the temporary directory, and a restart loses its sessions.

**The `env` option of `claudeExecution` adds variables.** This breaks a host
that passed a whole environment. The base is the allowlisted variables of the
host process. They are `PATH`, `HOME`, the locale, the proxy and certificate
variables, `CLAUDE_CODE_OAUTH_TOKEN`, and the `ANTHROPIC_` and `LC_`
prefixes. A value in `env` adds or replaces a variable, and `undefined`
removes one. The variables of the seat win over `env`. The executor then
removes the variables of a Claude Code session of the host. A host on
Bedrock, Vertex, Foundry, or another provider that `ANTHROPIC_*` does not
cover must pass the variables that provider needs. The allowlist holds no
`AWS_` or `GOOGLE_` prefix. The shell of the seat reads no file of the host
user.

#### The Codex executor

**The Codex executor runs on `codex app-server`.** This breaks a host that
read the SDK or the room tools server. `@openai/codex-sdk` and
`@modelcontextprotocol/sdk` leave the package. It depends on `@openai/codex`
0.159.2 and resolves the binary from it. The executor speaks JSON-RPC over
stdio with one process for each activation. The room tools and the tools of
the agent are dynamic tools of the thread. The files `bridge.ts`,
`wire.ts`, and `room-tools-server.ts` and the local socket are gone, and the
build has one entry. The `codex()` options that remain keep their names. The thread policy
is the read-only sandbox, `approvalPolicy: never`, and an empty `cwd`.
`skipGitRepoCheck` has no use and is gone.

**A Codex seat signs in with `CODEX_API_KEY` through the app-server.** The
app-server ignores the `CODEX_API_KEY` variable. When the seat environment
holds the key, the executor signs in with `account/login/start` of type
`apiKey`, and it sets the ephemeral credential store. Codex keeps the key in
memory and writes no `auth.json`. The key wins over a linked `auth.json`. A
seat with no key reads the linked `auth.json`, a ChatGPT sign-in, as before.
A failed login names the cause and never the key.

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

**The Codex binary runs with an allowlisted environment and a private
`HOME`.** Before, `codexExecution` passed the whole environment of the host to the
binary and to `codex debug models`, with only `CODEX_HOME` replaced. The
`env` option of `codexExecution` and `HomeOptions` changes meaning. It no
longer replaces the environment. It lays over the allowlisted variables of
`process.env`: a value adds or replaces a variable, and `undefined` removes
one. The base holds the path, locale, temporary directory, proxy, and
certificate variables, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`,
`CODEX_CA_CERTIFICATE`, and the variables with the prefixes `OPENAI_` and
`LC_`. On Windows the names compare without case. A secret of the host, such as a cloud key or a
token, does not reach the binary. A provider with
another `env_key` needs its variable in `env`.

**The seat sets `HOME` and `USERPROFILE`.** Both name `home/home`, a private
directory that `openHome` creates with the mode `0700`. `CODEX_HOME` stays
`home`. Codex finds skills under `$HOME/.agents/skills`, so a skill of the
host user no longer reaches the prompt of a seat. The defaults of `home` and
`login` still read the `HOME` and the `CODEX_HOME` of the host, which are
`process.env` with `env` laid over it. `SeatHome` gains `privateHome`.

**A Codex seat has no native tools, ever.** Files and a shell come only from
the workspace tools, behind the workspace port, so it makes no difference
whether the workspace is in memory, a directory, or a remote workstation.
The option `nativeTools` of `codex()` is gone, and so is the mode
`'codex'`. The policy options `sandboxMode`, `approvalPolicy`,
`networkAccessEnabled`, `workingDirectory`, and `additionalDirectories` are
gone, and the type `CodexPolicy` with them. `modelReasoningEffort` and
`reasoningSummary` stay on `CodexOptions` and `CodexExecutor`. Every seat
runs the exclusive recipe: the patched catalog entry, a read-only sandbox,
no network, no approval, an empty working directory, and the seat text in
`baseInstructions`. A seat that needed a shell or file edits now takes the
workspace tools in `bundles`. The trace maps the items that a seat can
produce: `agentMessage`, `reasoning`, `dynamicToolCall`, the warnings and
errors that Codex reports, and the usage of a turn. An item of any other
type becomes a warning `notice` that names the type. A say no longer cites the
paths that Codex changed. The core drops `RunningActivation.roomTools` and the
type `RoomToolOptions`, because only the Codex executor used them.

**Breaking: the seat text of a Codex seat leaves the first user message.**
In 0.4.0 the executor put the harness note, the mechanism, and the agent
instructions in front of the view in the first user message, under the base
prompt of Codex, about 18 KB. The executor now passes that text as
`baseInstructions` of `thread/start` and `thread/resume`, fixed for the
activation. It replaces the base prompt of Codex, so the first developer
message is the seat text and no message starts with "You are Codex". The
first user message holds the view alone.

**The binary tier proves the isolation and the link.** The host home of
`test/binary.ts` holds a `config.toml` that reroutes the provider and starts
an MCP server, and an `AGENTS.md` with a marker. A test asserts that none of
them reaches a seat. Another test runs a provider on the linked login, with a
proxy that refuses every outbound connection.

#### The trace

**The `approval` step is gone.** No executor writes it. Pi and Codex never
wrote it, and the Claude executor wrote it only for a permission request,
which no seat raises now. The step vocabulary has eleven kinds, with `session`
in the place of `approval`. The Workbench no longer draws an `approval` line.

**Breaking: the step vocabulary has an eleventh kind, `notice`.** A `notice`
is a non-fatal diagnostic of the harness:
`{ type: 'notice', level: 'info' | 'warning', text, data? }`. A notice never
gates an activation. A consumer that switches on the step type must handle
the new kind. The Codex executor records a `notice` at level `warning` for
each `warning`, `configWarning`, and `deprecationNotice` and for each `error`
that will retry, such as an unknown setting in the config or a reconnect.
A failed turn stays in the `end` step.

#### The workspace

**The workspace owns its port.** `@ambionframework/workspace`,
`@ambionframework/workstation`, and `@ambionframework/just-bash` import no
Pi package and declare no dependency on `@earendil-works/pi-agent-core`. A
host with Claude or Codex seats installs no Pi package to use a workspace.
`WorkspaceEnv` no longer extends the `ExecutionEnv` of Pi. Every member takes
an optional `signal?: AbortSignal` in place of a Pi `Context`, and `onUpdate`
receives one `ShellOutputView` in place of a `ShellOutputUpdate`.
The port drops the members that nothing calls: `joinPath`, `readTextLines`,
`openTextLineReader`, `createTempDir`, and `createTempFile`. `ShellExecResult`
and `ShellOutputView` drop `spillPath` and `lastLineBytes`, and `capture`
drops `spill`. These exports change on the root entry of the workspace:

- Removed: `BACKGROUND_CONTEXT`, `TMP`, `tempDirPath`, and `tempFilePath`.
- Added values: `ok`, `err`, `FileError`, and `ShellError`.
- Added types: `Result`, `FileResult`, `FileErrorCode`, `ShellErrorCode`,
  `FileInfo`, `ShellExecResult`, `ShellOutputLimits`, `ShellOutputTruncation`,
  and `ShellOutputView`.
- Changed: `deliverView` loses its `context` argument.
  `runScript`, `SqlEnv.run`, `WorkspaceFiles`, `WorkspaceLog.append`,
  `AuditLog.append`, `sqlImport`, and `sqlResult` take a signal in place of
  a `Context`. `HomeEnv` drops `joinPath`, `readTextLines`, and
  `openTextLineReader`. The `record` of `WorkspaceLog.append` is an `object`
  in place of the `JsonValue` of Pi.

`workspaceConformance` drops the case for temporary names. A new check packs
the three packages and finds no Pi package in their manifests or in their
dependency closure.

**A bash backend takes its git backend, and the types check the pair.**
`memoryBackend` takes `git` in its options, and `directoryBackend(root,
options)` takes `git` in a second parameter. Both take a `JustGitBackend`.
`WorkstationOptions` gets `git`, of the new exported type
`WorkstationGitBackend`. `BashBackend` gets `readonly git?: GitBackend`, and
`openWorkspace` opens `bash.git` under its own owner. A git backend of
another package is now a compile error. Each bash backend reads the access
of its git backend with no cast. Every tool text, guidance text, and
credential flow stays the same.

**The pairing checks are gone.** `WorkspaceBackends.git`, `BashServices`,
the third parameter `services` of `BashBackend.connect`,
`BashBackend.gitTransports`, `GitAccess`, `GitBackend.access`, and the field
`transport` of `JustGitAccess` and `WorkstationGitAccess` no longer exist.
`openWorkspace` no longer throws for a git backend whose transport the bash
backend does not carry. `justGitBackend` still has `access: JustGitAccess`,
and `workstationGitBackend` still has `access: WorkstationGitAccess`, on the
types of their own packages. `@ambionframework/just-bash` exports the new
type `DirectoryBackendOptions`.

**`GitConformanceStore.bash` is a function.** `bash(git)` opens a bash
backend for one git backend, in place of the field `bash`. The registration
cases open a new bash backend for each workspace, so the suite no longer
borrows one bash backend with a disposal that does nothing.

**The audit log names its threshold `rotateBytes`.**
`AuditLogOptions.maxBytes` and `AuditLog.maxBytes` of
`@ambionframework/workspace` are now `rotateBytes`, the name that
`openLog` and the room mirror use. The default stays 5 MiB. The refusal of
a threshold that is not positive and finite now starts with `rotateBytes`.
Before, it started with `maxBytes`. A host that sets `audit: { maxBytes }`
sets `audit: { rotateBytes }`.

**The git registration type is renamed.** The workspace git entry replaces
`TemplateRegistration` with `RepositoryRegistration`, exports `SHARED` and
`writableBy`, and reserves `shared` as an agent name. There is no alias or
migration. Journal bodies and stored schemas do not change.

#### The core exports and tests

**`Pass.agentTools` is gone.** `Pass.tools` holds the room tools that the
purpose grants, then the tools of the definition. A closing activation gets
the room tools alone. Claude and Codex joined the two lists at once, and
they now host `pass.tools`. Pi hosts the room tools from `pass.tools`, the
tools that the definition does not name, and builds the tools of the
definition from their `AmbionTool`s as before.

**The main entry exports `ToolContent` and `contentText`.** `ToolContent` is
one part of what a tool hands back to the model, and `ToolResult.content`
holds a list of them. `contentText(content)` joins the text parts of such a
list. `ToolContent` replaces `RoomToolContent`, which the hosting entry
exported. The hosting entry no longer exports it. The content union was
written in `bundle.ts`, in `room-tools.ts`, and in `wire.ts` of the Codex
package. The text join was written in the core test language, twice in the
Pi executor, and twice in the workspace.

**One scripted test language serves the core and Pi.**
`@ambionframework/ambion/testing` renames the type `Turn` to `Reply`,
because `turn` means one request to a provider in Pi. `seat(name)` joins the verbs `callTool`,
`say`, `schedule`, `spend`, and `quiet` in that entry. `byAgent` is generic:
`byAgent<Input, Out>` routes a script that reads a `ScriptStep` and a script that
reads a Pi `Context` with one function. `@ambionframework/pi/testing` drops
`callTool`, `say`, `schedule`, `quiet`, `seat`, and `byAgent`. A Pi script
reads these verbs from the core entry. The Pi type `Script` is now
`PiScript`, and a `PiScript` answers with a `Reply` or an
`AssistantMessage`. `isClosingContext` is the Pi check of a context,
and the view check of the core is `isSummarizing`. The Pi
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

**`ActivationOpener` is a function of the activation.**
`@ambionframework/ambion/hosting` exports `ActivationOpener` as
`(activation: ExecutorActivation) => RunningActivation`. Before, `Executor`
was an
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

**An executor family is one call.** `defineExecution(kind, build)` in
`@ambionframework/ambion/hosting` now returns the function that gives an
execution for a set of options, and it registers the execution with no
options as the default of the kind. `build` takes the host and the
options. `piExecution`, `claudeExecution`, and `codexExecution` are the
results of that call, with unchanged signatures. `localExecution` stays for an execution that is not a
family. `@ambionframework/claude` exports one option type,
`ClaudeExecutionOptions`,
and `@ambionframework/codex` exports `CodexExecutionOptions`.

**A room read is the one read of pending says and waits.** `Room` drops
`pendingFor(person)` and `scheduled()`, and the Cloudflare `RoomObject`
drops `scheduledSays()`. Read `scheduled` from `room.read()`, and call
`awaitingFor(read, person)` on the read. Journal bodies and stored formats do
not change.

**One fixture type, one `check`, and one case runner serve the conformance
suites.** `@ambionframework/journal/conformance` exports three new parts:
`check(condition, what)`, `ConformanceFixture<Subject>`, and
`conformanceSuite(fixture, cases)`. `ConformanceFixture<Subject>` has a
`name` and an `open()` that returns the subject. `conformanceSuite` opens the
subject for each case, runs the body, and disposes the subject after it.
`@ambionframework/ambion/conformance` and
`@ambionframework/workspace/conformance` export the same three. The fixture
type replaces three names, and each suite keeps its subject type:
`StorageBackend` is now `ConformanceFixture<OpenedBackend>`,
`ConformanceBackend` is now `ConformanceFixture<WorkspaceConformanceStore>`, and
`ObjectConformanceBackend` is now `ConformanceFixture<ObjectConformanceStore>`.
A storage fixture now needs a `name`, as the other fixtures had.
`@ambionframework/workspace/conformance`
also exports `WorkspaceConformanceStore`, the subject of
`workspaceConformance`. `GitConformanceBackend` extends
`ConformanceFixture<GitConformanceStore>`. The case names and messages do not
change.

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
[Simplification](#simplification-1) and [Breaking changes](#breaking-changes-1)
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
