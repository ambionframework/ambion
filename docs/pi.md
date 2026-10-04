# The Pi executor

`@ambionframework/pi` runs Ambion agents on Pi. This page holds what is
specific to the Pi adapter. [Executors](executors.md) holds the shared
contract: the activation flow, the room tools, exchange continuity, failure
classification, the step vocabulary, and the trace.
[The Claude guide](claude.md) covers a second shipped executor kind, and [the
Codex guide](codex.md) a third. [The
README](../README.md) holds the positioning.

## What it is and when to use it

**The Pi harness of `@earendil-works/pi-durable` owns the model loop, the
session, its persistence and its compaction. The caller owns the process.**
`pi()` defines the executor of one agent. `piExecution()` gives a room or a
runtime the services that run it. The executor adapts the harness to the
contract of the room. The package holds Pi and the model registry. The
kernel names no model library.

Use Pi when the loop runs in the host process and the agent needs:

- **Any provider that the Pi registry lists.** The model id is
  `provider/model-id`.
- **Tools that run in process.** A tool is a function of the host.
- **Steering during a pass.** A line that lands mid-activation reaches the
  model as a write that the harness places before its next request.
- **A host that runs seats apart from the room.** The Cloudflare adapter
  builds its seats on `piExecution`.
- **A deterministic test.** A scripted stream replaces the provider.

Use [the Claude executor](claude.md) when the agent needs the built-in tools
of Claude Code.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

Every package needs Node 22.19 or newer. The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see
[Toolchain](toolchain.md#9-release-and-publishing).

**The registry reads the key from the environment.** The stream takes the
provider of the model, writes it in upper case, replaces each `-` with `_`,
and reads `<PROVIDER>_API_KEY`. The id `anthropic/claude-sonnet-5` reads
`ANTHROPIC_API_KEY`. The id `google-vertex/...` reads `GOOGLE_VERTEX_API_KEY`.
A key that Pi passes in its own stream options wins over the variable.

**A subscription sign-in replaces the key.** Pi signs in to Claude Pro and
Max (`anthropic`) and to ChatGPT Plus and Pro (`openai-codex`) with OAuth.
Run `loginPi('anthropic', fileCredentials(path))` once on a host that has a
browser. Pass the same store to `piExecution({ credentials })`. A provider
with a stored sign-in answers with it, and Pi does not read its
`<PROVIDER>_API_KEY`. A provider with none keeps the key rule above. [Subscriptions](#subscriptions)
holds the steps.

**The registry loads on the first request.** A room with a scripted `stream`
never loads it and needs no key.

## A complete example

```ts
import { defineAgent, definePerson, defineTool, startRoom } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { Type } from 'typebox';

const stock = defineTool({
  name: 'stock_level',
  description: 'Read the units in stock for one item.',
  parameters: Type.Object({ item: Type.String() }),
  execute: async ({ item }) => `${item}: 42 units`,
});

const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  executor: pi({
    instructions: 'Read the stock level before you answer. Speak when it changes the answer.',
    model: 'anthropic/claude-sonnet-5',
    tools: [stock],
    activationTokenLimit: 60_000,
  }),
});

const priya = definePerson({ name: 'priya', identity: 'Coordinates deliveries.' });

const room = await startRoom({
  name: 'delivery',
  agents: [inventory],
});

try {
  const visit = await room.visit(priya);
  const exchange = await visit.send({ text: 'Can we promise 10 units of pumps?' });
  for (const message of await exchange.waitForClose()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

**Importing `@ambionframework/pi` defines the default Pi execution.** It
gives the steps of each activation to the logger of the runtime. A host that
needs a scripted stream or its own session place passes
`piExecution(options)` as `execution`. The runtime supplies the storage and
the limits. [Executors](executors.md#the-executor-contract) states how a
room resolves an execution.

## Options

**`pi(options)` returns a frozen executor of kind `pi`.** The kernel
validates the shared fields. Pi adds `model` and `compaction`.

| Option                 | Required | Default             | Meaning                                                                                                |
| ---------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `instructions`         | Yes      | None                | The private guidance of the agent.                                                                     |
| `model`                | Yes      | None                | A Pi model id, `provider/model-id`.                                                                    |
| `tools`                | No       | None                | The tools of the agent, from `defineTool` or `fromPiTool`.                                             |
| `bundles`              | No       | None                | Tool bundles. Their guidance joins the prompt after the speaking policy.                               |
| `compose`              | No       | `quickjsRuntime()`  | The `compose` and `describe` tools of the seat: a runtime and optional limits ([Compose](compose.md)). |
| `speaking`             | No       | `DEFAULT_SPEAKING`  | The speaking policy. It replaces the default.                                                          |
| `activationTokenLimit` | No       | The whole record    | The token limit of the record one activation reads. A positive integer.                                |
| `estimateTokens`       | No       | `'length'`          | The name of the estimator in the runtime that counts tokens. It needs the limit.                       |
| `compaction`           | No       | The harness default | When the harness compacts the session. A partial Pi `CompactionPolicy`.                                |
| `thinking`             | No       | `'off'`             | How much the model reasons before it answers. A Pi thinking level.                                     |

**Compaction is on by default.** The harness holds the default policy. The
executor passes `compaction` to the harness as it is, and a field that the
definition omits keeps the default. The policy has `enabled`,
`reserveTokens`, `keepRecentTokens`, and `trigger`. `pi()` throws when a
count is negative or not a safe integer, and when `enabled` is not a
boolean. The harness does not check the policy.

**`piExecution(options)` takes four options.**

| Option        | Default                                                  | Meaning                                                                                   |
| ------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `stream`      | The Pi registry stream                                   | A Pi `StreamFn`. A custom stream makes the model resolve to a stub (see Testing).         |
| `sessions`    | `'disk'`                                                 | Where the seats keep their sessions: `'disk'` or `'memory'`.                              |
| `sessionDir`  | `ambion-pi-sessions-<uid>` in the OS temporary directory | The directory on the local disk for the sessions of the seats.                            |
| `credentials` | None                                                     | A Pi `CredentialStore` that holds subscription sign-ins, such as `fileCredentials(path)`. |

**Every stream keeps the sessions on the disk by default.** A custom
`stream` makes the model a stub, and the sessions stay on the disk.

**`sessions: 'memory'` keeps the sessions in memory.** Each seat keeps its
sessions for as long as the connector lives, and the room writes nothing to
the disk. A test uses it, so that no room opens a session of another run.
The memory store keeps the two newest sessions of each room and seat: the
session of the open exchange, and the session of the exchange before it
for its summary. It deletes the others.
`createExecutionServices` takes the same `PiExecutionOptions`.
`piExecution` takes its clock from the runtime.

`pi()` throws at definition time when `estimateTokens` has no
`activationTokenLimit`, when the limit is not a positive integer, and when
`estimateTokens` is not a name.

**`estimateTokens` names an estimator in the runtime.** The room runs it, so
the definition carries the name alone. `length`, the default, counts
`Math.ceil(text.length / 4)`. `createRuntime({ estimators })` registers
other names. [History and limits](room.md#history-and-limits) states the
rule.

## Subscriptions

**A subscription needs a store and one sign-in.** Pi runs the OAuth flow of
the provider and keeps the credential in a `CredentialStore`. The package
ships `fileCredentials(path)`, one JSON file keyed by provider id.

```ts
import { fileCredentials, loginPi, piExecution } from '@ambionframework/pi';

const credentials = fileCredentials('/var/lib/ambion/auth.json');

// Once, on a host with a browser. The sign-in asks on the terminal.
await loginPi('openai-codex', credentials); // or 'anthropic'

// Every run after that.
const execution = piExecution({ credentials });
```

The model id names the provider. `openai-codex/<model>` runs on the ChatGPT
sign-in, and `anthropic/<model>` runs on the Claude sign-in. `loginPi`
takes an `AuthInteraction` as its third argument, for a host that asks in
another way than on a terminal.

**The store rotates the refresh token.** Each refresh gives a new refresh
token and voids the old one. `fileCredentials` writes the file through a
lock file and a rename, so two seats and two processes on one disk never
lose a rotated token. The file has mode `0600`. It holds the same power as
the account, so keep it out of the repository and out of the room.

**A stored sign-in owns its provider.** An `ANTHROPIC_API_KEY` in the
environment does not override a stored `anthropic` sign-in. Remove the
credential with `store.delete('anthropic')` to use the key again.

**A host with no disk supplies its own store.** `fileCredentials` loads the
Node file system on first use. A Cloudflare seat passes any object that
implements the Pi `CredentialStore`: `read`, `list`, `modify`, and `delete`.
`modify` must serialize writes for one provider, because it holds the
refresh.

**A revoked sign-in is a permanent failure.** An `invalid_grant` on refresh,
and a provider with no sign-in and no key, fail the seat with no retry.
Run `loginPi` again.

**The cost is notional.** The `usage` steps price tokens at the list price
of the model. A subscription bills nothing per token, and it has its own
usage limit. A limit that the provider reports is a permanent failure.

**Read the terms of the provider first.** A provider may restrict the use of
a consumer subscription outside its own clients. The terms are the choice
of the person who owns the account.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position and the record window. Pi adds these facts.

**One harness serves one activation.** The first pass resolves the model,
opens or creates the session storage, binds the tools, and opens one
pi-durable `Harness` over the storage. The harness holds one root
conversation. Every pass of the activation submits one input to that
conversation, and resolves when the submission settles. The harness runs
with the `thinking` level of the definition.

**The system prompt is the mechanism and the agent part.** A prompt section
of the harness renders `pass.mechanism` and `pass.agent` before each
request. The section has no tag, so the model reads the text as the executor
built it. The harness writes the prompt entry after the first input. A
hook moves the first prompt entry to the head of each request, so the
provider sends it as its system prompt. The stored session keeps its order.
A later pass changes the prompt with the view in hand. The text of
`pass.record()` is the first input.

**Each range of the record goes into the session as a marker.** A view, a
delta, and a steered line each write an entry of kind `ambion.record`. Its
data hold `after` and `through`: the position the range starts after and
the position it runs through. A range of a view or a delta carries no model
message. Its text joins the user input of the pass. A steered line carries
its text as a user message of its own entry. The provider receives the text
alone, as a user message.

**`readThrough` follows the exact provider input.** A hook of the harness
runs before each provider request. The executor reports the ranges that the
pass holds, the steered lines that the harness placed, and the tool results
that the request holds. The core joins the ranges into the highest
contiguous position they reach. The room tool answers also move the
position; see [Executors](executors.md#how-an-activation-runs).

**A steer is a write to the conversation.** A line that lands during a pass
becomes a write that the harness queues. The harness places it before the
next provider request that follows a tool result. The executor calls `read`
for the line when that request holds it. A line that lands while the pass
prepares its input joins that input.

**A line that the answer outruns stays unread.** The model can answer with
no tool call, and the harness then places the queued line after the answer.
No request holds the line. The executor withdraws the write when it can,
and the `steer` step reports `consumed: false`. The next pass carries the
line once in its delta.

**A line that lands between passes waits for the record.** The core runs a
pass with the delta when the last position of the room is past
`readThrough`. A delta with no message in it starts no pass, and the core
takes the view as read.

**The harness does not retry a failed request.** The executor sets the
retry policy of the harness to `{ enabled: false, maxRetries: 0 }`, and the
stream option `maxRetries` to `0`, so the provider client does not retry
either. A failed request fails the pass, and the room owns every retry.

**The harness compacts the session.** When the context of a request passes
the threshold of the policy, the harness asks the same model for a summary.
The summary replaces the older entries, and the latest `keepRecentTokens`
stay whole. A session with fewer tokens than `keepRecentTokens` has nothing
to compact. The summary request costs tokens. Its usage joins the activation
as a `usage` step at the end of the pass. `readThrough` never moves back.

**The harness recovers from an overflow once, when compaction is on.** A
context-overflow error makes the harness compact and send the request
again. With `compaction.enabled` set to `false`, the error fails the pass,
and the room classifies it. A `length` stop below the output limit of the
model ends the pass with `stop: 'length'`.

**The stub model of a scripted stream reports a window of one million
tokens.** A scripted room compacts only when its definition sets
`compaction.reserveTokens` close to the window of one million tokens.

**A fault of the storage fails the pass.** A storage that fails a commit
poisons the session of the harness. The harness reports the fault and
settles no submission after it. The executor turns the first report into a
transient failure of the pass. The executor aborts the conversation first,
so no tool and no request follows the failed pass. The room then retries.

## How room tools reach the harness

[Executors](executors.md#the-room-tools) states the room tools, the commit
key, and the room answers.

**The room tools are harness tools bound to the activation.** The harness
calls them in the same process, so it needs no transport. A room tool that
fails answers with an error result, so the model reads the text.

**The executor builds the tools of the definition from each `AmbionTool`.**
It hosts only the room tools of `pass.tools`.
[Executors](executors.md#the-room-tools) states the fields of a tool that
the harness reads and a `BoundTool` does not carry.

**The model holds exactly the tools of the activation.** One extension of
the harness holds the room tools, the tools of the definition, and the tools
of its bundles. The harness adds no built-in tool, no skill, and no prompt
template. The
skills of an agent come from its workspace bundle ([Skills](skills.md)). A
call to a tool the model does not hold gets an error result, and the pass
continues. A continued session takes the tools of the activation that
continues it: a summary activation holds `say` alone.

**A tool result reaches the model whole.** The harness bounds a tool result
to 2000 lines and 50 KiB unless the tool sets `outputLimits`. Every tool of
the executor sets the limits to the largest safe integer. The tool owns the
size of its result.

**An `unknown` or `stale` answer ends the pass.** The executor cuts the activation
and stands the seat down. The tool result names why the pass ended, and no
further pass follows.

## Tools and bundles an agent can add

[Definitions and tools](agent.md#tools) states `AmbionTool`, `defineTool`,
and how a bundle adds tools and guidance. Pi adds these facts.

**The executor wraps a tool as a harness tool.** Its context carries
`agent`, `signal`, `callId`, `onUpdate`, `room`, `activation`, and
`exchange`. The signal is the abort signal of the pass. A string result
becomes text content. A thrown error becomes a tool error. An abort of the pass throws on, so
the harness records the abort.

**`fromPiTool` adapts a native Pi tool.** It keeps the name, the schema,
`prepareArguments`, and `executionMode`, and passes the call id, the signal,
and the update callback through. It takes no output declaration, so
`compose` binds the tool as text.

**The harness prepares and checks the arguments, and the executor calls
`invokeChecked`.** `toolsFor` passes the step sink of the activation to
`invokeChecked`, with the room tools of the pass. It hands both to the
`compose` tool and to no other tool.
[Compose](compose.md#how-compose-runs-a-nested-call) states what the
primitive conversion of the harness means for a nested call.

**The `details` of a tool result must be JSON.** The session writes every
tool result to its storage. The executor drops `details` that JSON cannot
hold.

## Policy and the trust boundary

**Pi runs every tool on the host.** A tool has the privileges of the host
process. Pi has no permission layer and no sandbox. The
definition is the whole policy: a tool that the definition omits does not
exist for the model.

**What the model sees.** The model sees the system prompt at the head of
the request, the record, and the tools that
[Definitions and tools](agent.md#tools) lists for the activation. The model sees no environment variable and no key.

**What the host holds.** The registry stream reads the provider key in the
host process, and it sends the key to the provider only. A tool that reads
`process.env` or the disk gives the model what it reads. Give a tool the
narrowest reach that the job needs, and use a workspace backend for files.

**The credential file holds the sign-in of the account.** A host that sets
`credentials` gives every tool of the host process the same reach as the
stream. A tool that reads the disk can read the file. Keep such tools off
a seat that runs on a subscription, and name a file that the host user
alone reads.

**The session files hold the whole transcript.** On Node, the harness
writes each session to a JSONL storage under `sessionDir`: every input,
every answer, and every tool result. The executor deletes no file. A host that
keeps secrets out of the disk names a managed `sessionDir` and removes old
files itself.

**The default directory is in the shared temporary directory.** It is
`ambion-pi-sessions-<uid>` in the OS temporary directory, which every local
user shares. The executor creates it with access for its owner only. It
refuses a link, and a directory that another user owns. The sessions then
stay in memory.

## Exchange continuity

[Executors](executors.md#exchange-continuity) states the rule, the recorded
session, and the fresh start.

**A session carries the id of the activation that began it.** The release
records `{ kind: 'pi', id }`. An activation reopens the session only
when `pass.resumeId` names that id. Its first input is `pass.record(after)`,
with `after` the position the session read through: the delta, after the
reminders of the tool bundles ([Processes](processes.md#reminders)). A
delta with no message starts no pass. A summary activation reads the whole
view. `readThrough` starts at the position the session read through.

**The ranges in the session hold the position it read through.** The
position is the largest `through` of the `ambion.record` entries that the
context still holds. The executor writes no other entry for it.

**A session that cannot open starts fresh.** A session the store does not
hold, cannot read, or that the harness cannot restore, closes and gives way
to a fresh session under the id of the activation. The activation does not
fail, and it reads the whole view. A JSONL file with a corrupt line is such
a session. A session the disk refuses to create stays in memory. A new
session whose id the store already holds takes a new id.

**A session that fails gives way too.** When the store fails a write during
a pass, the pass fails as transient. The release then records no session, so
the retry of the room does not continue the failed one. The retry reads the
whole view.

**A crash leaves no work behind.** A process that dies mid-pass leaves a
generation, a tool call, or a placed input in the storage. The harness does
not run them on open, and a later submit would resume them. Before any
submit, the executor aborts every submission and task that the storage
holds. The resumed pass sends one request, and it runs no tool again.

**A continued session omits what the last pass left unanswered.** A pass
that failed, was cut, or ended before a steered line leaves entries after
its last answer. The executor writes one `ambion.omit` entry with omit edits
for them. The model does not read them, and the delta gives it each range of
the record once. The entries stay in the storage.

**The sessions of a seat stay apart.** The open exchange can run beside
the summary of the exchange before it, and each continues its own session.

**Where the session lives.**

- **Node.** The harness writes each session to a JSONL storage under
  `sessionDir`, in a folder for each room, seat, and session id:
  `<sessionDir>/<room>/<seat>/<id>`. A restart on the same disk reopens it.
  A session the disk refuses stays in memory.
- **`sessions: 'memory'`.** A `MemoryStorage` of pi-durable keeps the two
  newest sessions of each room and seat in memory. A restart loses them.
- **Cloudflare.** The seat object keeps its sessions in memory on the
  object instance. An eviction loses them.

[The trace](executors.md#the-trace-log) shows the host's logger what the
model did.

## The step mapping

[Executors](executors.md#the-step-vocabulary) holds the twelve step kinds and
the trace policy. The table below gives the harness event behind each step. The
driver writes `pass`, `room`, and `end`.

| Step          | Source in Pi                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `thinking`    | `message_update` thinking deltas, then `message_end`. A block the stream did not send arrives whole. |
| `text`        | `message_update` text deltas, then `message_end`. A block the stream did not send arrives whole.     |
| `tool_call`   | `tool_execution_start`, with the call id, the tool name, and the arguments.                          |
| `tool_result` | `tool_execution_end`, with the result. A failed call adds `error` with the text of the result.       |
| `steer`       | Never. The core records it. The executor calls `read` when a provider request holds the line.        |
| `approval`    | Never. The `compose` tool records it through the step sink of the activation.                        |
| `usage`       | The `usage_changed` event, one for each answer. The compaction spend joins the last one.             |

A redacted thinking block adds no step. The trace policy of the definition
sets how much of `thinking` and tool output the journal keeps.

## Usage and cost

**The executor records one `usage` step for each provider request.** The
harness reports each request as a `usage` event, a failed request and a
compaction summary included. The step holds `input`, `output`, `cacheRead`,
`cacheWrite`, and `cost`. Pi computes `cost`
from the price table of the model in the registry. A stub model has a zero
price table. A provider that reports no usage gives zeros.

## Failure classification

[Executors](executors.md#failure-classification) states the shared rule.

**The executor reads a status only from a provider diagnostic.** A rate
limit names a token count that reads like a status, so free text never
gives one. The last diagnostic with a status wins.

**The shared classifier reads the text.** The
[text set](executors.md#failure-classification) holds the words of each
provider that Pi reaches.

**A fault in the configuration is permanent.** An unknown model id fails
on the first pass, and the room does not retry it. The harness codes
`model_unavailable` and `configured_tools_unavailable` are permanent for
the same reason: a retry reads the same configuration.

**The failure names the provider's words.** A provider error that arrives
as a status and a JSON body reads `400 invalid_request_error: <message>
(request <id>)`. The cause reads the original text.

## Testing

**A scripted stream tests the room with no model and no key.**
`@ambionframework/pi/testing` exports `scriptedStream`, `PiScript`,
`isClosingContext`, `contextText`, `toolNames`, `toolResultTexts`,
`scriptOf`, and `piExecutorFixture`. A script answers with the verbs of
`@ambionframework/ambion/testing`: `say`, `callTool`, `schedule`, `seat`,
`quiet`, and `byAgent`. The executor puts the stream in one provider of a Pi
`Models` collection, which holds the model of the seat under its provider
and id.

```ts
import { defineAgent, definePerson, isSaid, startRoom } from '@ambionframework/ambion';
import { byAgent, quiet, say } from '@ambionframework/ambion/testing';
import { pi, piExecution } from '@ambionframework/pi';
import { scriptedStream } from '@ambionframework/pi/testing';

const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  executor: pi({ instructions: 'Answer once.', model: 'anthropic/claude-sonnet-5' }),
});

const stream = scriptedStream(
  byAgent({
    inventory: (_context, _agent, request) => (request === 1 ? say('42 units in stock.') : quiet()),
  }),
);

const room = await startRoom({
  name: 'delivery-test',
  agents: [inventory],
  execution: piExecution({ stream, sessions: 'memory' }),
});

try {
  const visit = await room.visit(definePerson({ name: 'priya', identity: 'Asks.' }));
  const exchange = await visit.send({ text: 'How many units?' });
  const said = (await exchange.waitForClose()).filter(isSaid);
  console.log(said.map((message) => message.text));
} finally {
  await room.stop();
}
```

**The scripted stream routes on the seat.** The stub model carries the seat
name in `model.name`, so a script never reads the prompt to learn who it
serves. `scriptedStream` counts calls for each seat, answers an abort with an
aborted message, and turns a script that throws into an error message. A
test that needs no Pi imports `scripted` from
`@ambionframework/ambion/testing`, which runs a script with no model at all.

**The stream turns a reply into a message.** A reply with calls becomes one
message with one tool call for each call, and the stop reason `toolUse`. An
empty reply becomes a text message that ends the pass. A script can also
return a Pi `AssistantMessage`, which the stream passes on unchanged. A test
uses a message for an error, a length stop, or a usage report.

**A reply that Pi cannot carry becomes an error message.** A `spend` reply
has no Pi meaning. A script that needs a usage report returns a message
with a `usage` field. A call whose arguments JSON cannot hold also fails,
because Pi tool calls carry JSON.

**`piExecutorFixture()` runs the executor suite.** It maps each plan of
`@ambionframework/ambion/conformance` to a script, and declares steering,
usage, permanent failure, and memory.
`packages/pi/test/executor-conformance.test.ts` runs the suite with no key.

**What the scripted tier proves.** It proves the room, the freshness rules,
the steer path, exchange continuity, compaction, the trace steps, and the
failure paths. Tests in `packages/pi/test` cover each, and
`packages/claude/test/mixed-room.test.ts` runs a Pi seat beside a Claude
seat.

**What it cannot prove.** A scripted stream sends no real provider payload.
It shows nothing about the registry, the price tables, the real usage of a
provider, the length of a real context, or what a real model says.

**The live tier runs on a real provider.** The scenarios in
`packages/ambion/test/live` use `pi()` and `piExecution()` with a key from
`<PROVIDER>_API_KEY`. `pnpm test:live` runs them and costs money. CI runs the
tier on `main` and on a weekly schedule. See [Toolchain](toolchain.md). The
Pi package has no live test of its own. The Workbench live tests also run
Pi seats.

## Troubleshooting

| Symptom                                                             | Cause                                                                                                                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each seat fails at once with `no_execution`                         | No loaded package serves the kind of the seat. Import the executor package, or pass `piExecution()`.                                                                    |
| `Unknown model '...' for agent '...': expected 'provider/model-id'` | The id has no provider prefix, or the registry lacks it. The failure is permanent.                                                                                      |
| The seat is abandoned after one attempt                             | A permanent failure. Read the `error` event. Check `<PROVIDER>_API_KEY`, the credit, and the usage limit.                                                               |
| `invalid_grant` or `Provider is not configured`                     | The provider revoked the stored sign-in, or the store holds none. Run `loginPi` again, and pass the same `credentials`. A refresh that fails on the network retries.    |
| `The Pi executor cannot run an executor of kind 'claude'`           | A Claude seat reached a Pi executor through an execution with no kind. Pass the execution of each kind.                                                                 |
| `An agent estimateTokens needs an activationTokenLimit.`            | `estimateTokens` is set with no limit.                                                                                                                                  |
| `Agent '...' names estimator '...', and the runtime holds none ...` | The room start found no estimator by that name. Pass it in `estimators` to `createRuntime`.                                                                             |
| The agent never speaks                                              | Silence is legal. Pass a `logger` to `createRuntime` and read the thinking and the tool calls there.                                                                    |
| A say returns `Not delivered: the room moved`                       | The freshness rule refused a say against newer record. The model reads the new messages, then says its message again unless they already say it or make it unnecessary. |
| A steer shows `consumed: false`                                     | No provider request held the line before the pass ended. The next delta carries the line.                                                                               |
| The first activation after a restart re-reads the record            | The sessions were in memory, or the restart used another `sessionDir`. A new session starts.                                                                            |
| The session directory grows                                         | The executor deletes no session file. Remove old files under `sessionDir`.                                                                                              |
| The activation ends with `stop: 'length'`                           | The last model message hit a length limit. Shorten the record with `activationTokenLimit`.                                                                              |
