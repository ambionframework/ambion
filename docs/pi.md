# The Pi executor

`@ambionframework/pi` runs Ambion agents on Pi. This page holds what is
specific to the Pi adapter. [Executors](executors.md) holds the shared
contract: the activation flow, the room tools, exchange continuity, failure
classification, the step vocabulary, and the trace.
[The Claude guide](claude.md) covers a second shipped family, and [the
Codex guide](codex.md) a third. [The
README](../README.md) holds the positioning.

## What it is and when to use it

**Pi's `AgentHarness` owns the model loop, the session, its persistence and
its compaction. The caller owns the process.** `pi()` defines the executor
of one agent. `piExecution()` gives a room or a runtime the services that
run it. The executor adapts the harness to the contract of the room. The
package holds Pi and the model registry. The kernel names no model library.

Use Pi when the loop runs in the host process and the agent needs:

- **Any provider that the Pi registry lists.** The model id is
  `provider/model-id`.
- **Tools that run in process.** A tool is a function of the host.
- **Steering during a pass.** A line that lands mid-activation reaches the
  model through the steer queue of the harness lane.
- **A host that runs seats apart from the room.** The Cloudflare adapter
  builds its seats on `createPiExecutor` and `createExecutionServices`.
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

**The registry loads on the first request.** A room with a scripted `stream`
never loads it and needs no key.

## A complete example

```ts
import { defineAgent, defineHuman, defineTool, startRoom } from '@ambionframework/ambion';
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

const priya = defineHuman({ name: 'priya', identity: 'Coordinates deliveries.' });

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

**Importing `@ambionframework/pi` registers the default Pi execution.** It
gives the steps of each activation to the logger of the runtime. A host that
needs a scripted stream, custom storage, a transport, or limits passes
`piExecution(options)` as `execution`. [Executors](executors.md#the-executor-contract)
states how a room resolves an execution.

## Options

**`pi(options)` returns a frozen executor of kind `pi`.** The kernel
validates the shared fields. Pi adds `model` and `compaction`.

| Option                 | Required | Default                       | Meaning                                                                  |
| ---------------------- | -------- | ----------------------------- | ------------------------------------------------------------------------ |
| `instructions`         | Yes      | None                          | The private guidance of the agent.                                       |
| `model`                | Yes      | None                          | A Pi model id, `provider/model-id`.                                      |
| `tools`                | No       | None                          | The tools of the agent, from `defineTool` or `fromPiTool`.               |
| `bundles`              | No       | None                          | Tool bundles. Their guidance joins the prompt after the speaking policy. |
| `speaking`             | No       | `DEFAULT_GUIDANCE`            | The speaking policy. It replaces the default.                            |
| `activationTokenLimit` | No       | The whole record              | The token limit of the record one activation reads. A positive integer.  |
| `estimateTokens`       | No       | `Math.ceil(text.length / 4)`  | Counts tokens against the limit. It needs `activationTokenLimit`.        |
| `compaction`           | No       | `DEFAULT_COMPACTION_SETTINGS` | When the harness compacts the session. Pi's `CompactionSettings`.        |

**Pi's default compaction is on.** `DEFAULT_COMPACTION_SETTINGS` is
`{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }`. The
executor writes `compaction` only when the definition gives it. `pi()`
throws when a token count is negative or not a safe integer.

**`piExecution(options)` takes three options.**

| Option       | Default                                                  | Meaning                                                                           |
| ------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `stream`     | The Pi registry stream                                   | A Pi `StreamFn`. A custom stream makes the model resolve to a stub (see Testing). |
| `sessions`   | `'disk'`                                                 | Where the seats keep their sessions: `'disk'` or `'memory'`.                      |
| `sessionDir` | `ambion-pi-sessions-<uid>` in the OS temporary directory | The directory on the local disk for the sessions of the seats.                    |

**Every stream keeps the sessions on the disk by default.** A custom
`stream` makes the model a stub, and the sessions stay on the disk.

**`sessions: 'memory'` keeps the sessions in memory.** Each seat keeps its
sessions for as long as the connector lives, and the room writes nothing to
the disk. A test uses it, so that no room opens a session of another run.
The memory store keeps the two newest sessions of each room and seat: the
session of the open exchange, and the session of the exchange before it
for its summary. It deletes the others.
`createExecutionServices` takes the same three options.

The runtime supplies the clock, the call limits, the trace limits, the
logger, and the transport. `pi()` throws at definition time when
`estimateTokens` has no `activationTokenLimit`, and when the limit is not a
positive integer.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position and the record window. Pi adds these facts.

**One harness serves one activation.** The first pass resolves the model,
opens the session, binds the tools, and attaches one Pi `AgentHarness` to
the session. Every pass of the activation prompts the lane `main` of that
harness once, and resolves when the run ends. The harness runs with
`thinkingLevel: 'off'`, and no option changes it.

**The system prompt is the mechanism and the agent part.** The executor
gives the harness `mechanism` and `agent` from `renderActivation` as the
system prompt. The `context` part is the first prompt. Each later pass
replaces the system prompt with the one of the view in hand.

**Each range of the record goes into the session as a custom message.** A
view, a delta, and a steered line each become a Pi `CustomMessage` of type
`ambion.record`. Its details hold `after` and `through`: the position the
range starts after and the position it runs through. The session keeps the
details on the disk and in memory. The provider receives the text alone, as
a user message.

**`readThrough` follows the exact provider input.** The harness calls the
`toProviderMessages` hook of the executor with the messages of each
provider request. The executor reads the ranges from those messages, and
the position is the highest contiguous position they reach. A user message
with the same text never counts. The room tool answers also move the
position; see [Executors](executors.md#how-an-activation-runs).

**A steer goes to the steer queue of the lane.** A line that lands during a
run joins the queue as a `[new]` range, and the harness delivers it with
the next provider request. The trace records `steer` with `consumed: true`
when a provider request holds the line. A line that lands while the pass
prepares its run joins the prompt of the run. A line that no request holds
by the end of the run leaves the queue, and the trace records
`consumed: false`.

**A line that lands between passes waits for the record.** The trace
records `consumed: false`. `shouldRefresh` answers yes when the last
position of the room is past `readThrough`, and the driver runs a pass with
the delta. A delta with no message in it starts no run. The session takes
the view as read.

**The harness does not retry a failed request.** The executor sets the
retry policy of the harness to `{ enabled: false }` and the stream option
`maxRetries` to `0`, so the provider client does not retry either. A failed
request fails the pass, and the room owns every retry.

**The harness compacts the session.** When the context of a request passes
the context window less `reserveTokens`, the harness asks the same model
for a summary. The summary replaces the older messages, and the latest
`keepRecentTokens` stay whole. The summary request costs tokens, and its
usage joins the activation. `readThrough` never moves back.

**The harness recovers from an overflow once.** A context-overflow error,
or a `length` stop below the output limit of the model, makes the harness
compact once and send the request again. This happens also when compaction
is off, and no setting turns it off. The second request costs tokens, and
its usage joins the activation. When the second request overflows too, the
pass fails, and the room classifies the error. A `length` stop at the
output limit ends the pass with `stop: 'length'`.

**The stub model of a scripted stream reports a window of one million
tokens.** A scripted room compacts only when its definition sets
`compaction.reserveTokens` close to the window of one million tokens.

## How room tools reach the harness

[Executors](executors.md#the-room-tools) states the three tools, the commit
key, and the room answers.

**The room tools are harness tools bound to the activation.** The harness
calls them in the same process, so it needs no transport.

**The model holds exactly the tools of the activation.** The executor
passes the room tools, the tools of the definition, and the tools of its
bundles as the harness `tools`, and names each one in `activeToolNames`.
The harness adds no built-in tool, no skill, and no prompt template. A
call to a tool the model does not hold gets an error result, and the run
continues. A continued session takes the tools of the activation that
continues it: a closing activation holds `say` alone.

**An `unknown` or `stale` answer ends the run.** The executor aborts the activation
and stands the seat down. The tool result names why the turn ended, and no
further pass follows.

## Tools and bundles an agent can add

[Definitions and tools](agent.md#tools) states `AmbionTool`, `defineTool`,
and how a bundle adds tools and guidance. Pi adds these facts.

**The executor wraps a tool as a harness tool.** Its context carries
`agent`, `signal`, `callId`, `onUpdate`, `room`, `activation`, and
`exchange`. The signal is the abort signal of the run. A string result
becomes text content. A thrown error becomes a tool error.

**`fromPiTool` adapts a native Pi tool.** It keeps the name, the schema,
`prepareArguments`, and `executionMode`, and passes the call id, the signal,
and the update callback through.

**The `details` of a tool result must be JSON.** The session writes every
tool result to its store, and the disk store writes JSON.

## Policy and the trust boundary

**Pi runs every tool on the host.** A tool has the privileges of the host
process. Pi has no permission layer, no approval step, and no sandbox. The
definition is the whole policy: a tool that the definition omits does not
exist for the model.

**What the model sees.** The model sees the system prompt, the record, and
the tools that [Definitions and tools](agent.md#tools) lists for the
activation. The model sees no environment variable and no key.

**What the host holds.** The registry stream reads the provider key in the
host process, and it sends the key to the provider only. A tool that reads
`process.env` or the disk gives the model what it reads. Give a tool the
narrowest reach that the job needs, and use a workspace backend for files.

**The session files hold the whole transcript.** On Node, the harness
writes each session to a JSONL file under `sessionDir`: every prompt, every
answer, and every tool result. The executor deletes no file. A host that
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
records `{ harness: 'pi', id }`. An activation reopens the session only
when `spec.resume` names that id. Its first prompt is the delta: the record
beyond the position the session read through, after the reminders of the
tool bundles ([Processes](processes.md#reminders)). A delta with no message
starts no run. A closing activation reads the whole view. `readThrough`
starts at the position the session read through.

**A custom entry holds the position the session read through.** After each
pass that did not fail, the executor appends an `ambion.read` entry with
`readThrough`. The entry never reaches the model. When the write fails,
the activation runs on, and the next activation reads the whole view.

**A session that cannot open starts fresh.** A session the store does not
hold, cannot read, or that the harness cannot restore, closes and gives way
to a fresh session under the id of the activation. The activation does not
fail, and it reads the whole view. A session the disk refuses to create
stays in memory. When the harness refuses the setup of a fresh session too,
the session closes and the activation fails as transient.

**A session that fails after it opens gives way too.** When the session
fails as the lane goes back to its position, the harness closes, and a
fresh session takes its place. When the store fails a write during a
pass, the harness throws a fault, and the pass fails as transient. The
release then records a fresh, empty session, so the retry of the room does
not continue the failed one. The retry reads the whole view.

**A continued session goes back to the last position it read.** The lane
tip moves back to the newest `ambion.read` entry, or to the root when there
is none. A run that failed or was cut after that entry leaves the provider
input. A retry of a failed activation therefore gives the model each range
of the record once.

**The sessions of a seat stay apart.** The open exchange can run beside
the summary of the exchange before it, and each continues its own session.

**Where the session lives.**

- **Node.** The harness writes each session to a JSONL file under
  `sessionDir`, through Pi's `JsonlSessionRepo`, in a folder for each room
  and seat. A restart on the same disk reopens it. A session the disk
  refuses stays in memory.
- **`sessions: 'memory'`.** Pi's `MemorySessionRepo` keeps the two newest
  sessions of each room and seat in memory. A restart loses them.
- **Cloudflare.** The seat object keeps its sessions in a
  `MemorySessionRepo` on the object instance. An eviction loses them.

[The trace](executors.md#the-trace-log) shows the host's logger what the
model did.

## The step mapping

[Executors](executors.md#the-step-vocabulary) holds the ten step kinds and
the trace policy. The table below gives the harness event behind each step. The
driver writes `pass`, `room`, and `end`.

| Step          | Source in Pi                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `thinking`    | `thinking_delta` updates, then `thinking_end`. A block the stream did not send arrives whole.      |
| `text`        | `text_delta` updates, then `text_end`. A block the stream did not send arrives whole.              |
| `tool_call`   | `tool_start`, with the call id, the tool name, and the arguments.                                  |
| `tool_result` | `tool_end`, with the result. A failed call adds `error` with the text of the result.               |
| `steer`       | A line a provider request holds is `consumed: true`. A line no request holds is `consumed: false`. |
| `usage`       | The harness `usage` event, one for each provider request.                                          |
| `approval`    | Never. Pi has no approval step.                                                                    |

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

**A text that names a credit or an authentication refusal is permanent.**
The patterns are `credit balance`, `authentication_error`,
`permission_error`, `invalid_request_error`, an invalid API key,
`unauthorized`, and `permission denied`.

An unknown model id fails on the first pass as `transient`, so the room
retries it to the cap.

## Testing

**A scripted stream tests the room with no model and no key.**
`@ambionframework/pi/testing` exports `scripted`, `byAgent`, `speak`,
`quiet`, `callTool`, `seat`, `isClosing`, `contextText`, `toolNames`,
`toolResultTexts`, `scriptOf`, and `piExecutorHarness`. The executor puts
the stream in one provider of a Pi `Models` collection, which holds the
model of the seat under its provider and id.

```ts
import { defineAgent, defineHuman, isSpoken, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';
import { byAgent, quiet, scripted, speak } from '@ambionframework/pi/testing';

const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  executor: pi({ instructions: 'Answer once.', model: 'anthropic/claude-sonnet-5' }),
});

const stream = scripted(
  byAgent({
    inventory: (_context, _agent, call) => (call === 1 ? speak('42 units in stock.') : quiet()),
  }),
);

const room = await startRoom({
  name: 'delivery-test',
  agents: [inventory],
  execution: piExecution({ stream, sessions: 'memory' }),
});

try {
  const visit = await room.visit(defineHuman({ name: 'priya', identity: 'Asks.' }));
  const exchange = await visit.send({ text: 'How many units?' });
  const said = (await exchange.waitForClose()).filter(isSpoken);
  console.log(said.map((message) => message.text));
} finally {
  await room.stop();
}
```

**The scripted stream routes on the seat.** The stub model carries the seat
name in `model.name`, so a script never reads the prompt to learn who it
serves. `scripted` counts calls for each seat, answers an abort with an
aborted message, and turns a script that throws into an error message. A
test that needs no Pi imports `scripted` from
`@ambionframework/ambion/testing`, which runs a script with no model at all.

**`piExecutorHarness()` runs the executor suite.** It maps each plan of
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

| Symptom                                                             | Cause                                                                                                      |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Each seat fails at once with `no_execution`                         | No loaded package serves the kind of the seat. Import the executor package, or pass `piExecution()`.       |
| `Unknown model '...' for agent '...': expected 'provider/model-id'` | The id has no provider prefix, or the registry lacks it. The failure is transient, so the room retries it. |
| The seat is abandoned after one attempt                             | A permanent failure. Read the `error` event. Check `<PROVIDER>_API_KEY` and the credit of the account.     |
| `The Pi executor cannot run an executor of kind 'claude'`           | A Claude seat ran under `piExecution()`. Route with `composeExecutions`.                                   |
| `An agent estimateTokens needs an activationTokenLimit.`            | `estimateTokens` is set with no limit.                                                                     |
| The agent never speaks                                              | Silence is legal. Pass a `logger` to `createRuntime` and read the thinking and the tool calls there.       |
| A say returns `Not delivered — the room moved`                      | The freshness rule refused a say against newer record. The model reads the new messages and decides again. |
| A steer shows `consumed: false`                                     | No provider request held the line before the run ended. The next delta carries the line.                   |
| The first activation after a restart re-reads the record            | The sessions were in memory, or the restart used another `sessionDir`. A new session starts.               |
| The session directory grows                                         | The executor deletes no session file. Remove old files under `sessionDir`.                                 |
| The activation ends with `stop: 'length'`                           | The last model message hit a length limit. Shorten the record with `activationTokenLimit`.                 |
