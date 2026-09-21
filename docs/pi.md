# The Pi executor

`@ambionframework/pi` runs Ambion agents on Pi. This page holds what is
specific to the Pi adapter. [Executors](executors.md) holds the contract
between the driver and an executor, the step vocabulary, and the trace.
[The Claude guide](claude.md) covers a second shipped family, and [the
Codex guide](codex.md) a third. [The
README](../README.md) holds the positioning.

## What it is and when to use it

**Pi owns the model loop and the tools. The caller owns the process.**
`pi()` defines the executor of one agent. `piExecution()` gives a room or a
runtime the services that run it. The package holds Pi, the model registry,
and the audit of each seat's transcript. The kernel names no model library.

Use Pi when the loop runs in the host process and the agent needs:

- **Any provider that the Pi registry lists.** The model id is
  `provider/model-id`.
- **Tools that run in process.** A tool is a function of the host.
- **Steering during a pass.** A line that lands mid-activation reaches the
  model through `agent.steer`.
- **A host that runs seats apart from the room.** The Cloudflare adapter
  builds its seats on `createPiExecutor` and `createExecutionServices`.
- **A deterministic test.** A scripted stream replaces the provider.

Use [the Claude executor](claude.md) when the agent needs the built-in tools
of Claude Code.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

Every package needs Node 26.4 or newer. Until the packages publish to npmjs,
installation needs a GitHub Packages read token; see
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
import { pi, piExecution } from '@ambionframework/pi';
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
    memory: 'seat',
  }),
});

const priya = defineHuman({ name: 'priya', identity: 'Coordinates deliveries.' });

const room = await startRoom({
  name: 'delivery',
  agents: [inventory],
  execution: piExecution(),
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

`startRoom` and `resumeRoom` take `execution` for one room run.
`createRuntime` takes it for every room of the runtime. A room whose seats
run on more than one family passes `composeExecutions`; see
[Executors](executors.md#the-executor-contract).

## Options

**`pi(options)` returns a frozen executor of kind `pi`.** The kernel
validates the shared fields. Pi adds `model` and `memory`.

| Option                 | Required | Default                      | Meaning                                                                  |
| ---------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------ |
| `instructions`         | Yes      | None                         | The private guidance of the agent.                                       |
| `model`                | Yes      | None                         | A Pi model id, `provider/model-id`.                                      |
| `tools`                | No       | None                         | The tools of the agent, from `defineTool` or `fromPiTool`.               |
| `bundles`              | No       | None                         | Tool bundles. Their guidance joins the prompt after the speaking policy. |
| `speaking`             | No       | `DEFAULT_GUIDANCE`           | The speaking policy. It replaces the default.                            |
| `activationTokenLimit` | No       | The whole record             | The token limit of the record one activation reads. A positive integer.  |
| `estimateTokens`       | No       | `Math.ceil(text.length / 4)` | Counts tokens against the limit. It needs `activationTokenLimit`.        |
| `memory`               | No       | `'activation'`               | `'activation'` or `'seat'`. See [Memory modes](#memory-modes).           |

**`piExecution(options)` takes one option.**

| Option   | Default                | Meaning                                                                           |
| -------- | ---------------------- | --------------------------------------------------------------------------------- |
| `stream` | The Pi registry stream | A Pi `StreamFn`. A custom stream makes the model resolve to a stub (see Testing). |

The runtime supplies the clock, the storage, the call limits, the trace
limits, and the transport. `pi()` throws at definition time when
`estimateTokens` has no `activationTokenLimit`, and when the limit is not a
positive integer.

## How an activation runs

**One Pi agent serves one activation.** The first pass renders the whole
windowed view as one user message. The executor resolves the model, binds the
tools, and builds the agent. A later pass prompts the same agent with the
delta: the messages beyond what the agent has read, marked `[new]`. The Pi
transcript of the activation stays whole. The agent runs with
`thinkingLevel: 'off'`, and no option changes it.

**The system prompt is the mechanism and the agent part.** The executor
sends `mechanism` and `agent` from `renderActivation` as the system prompt.
The `context` part is the first user message. Each later pass replaces the
system prompt with the one of the view in hand.

**`readThrough` follows the provider request.** The position is the highest
contiguous record position in provider input. It advances in three cases:

- A provider request holds the initial prompt, a delta, or a steered line.
- The room accepts an ordinary `say`. The say confirms the seat read the
  record through that message.
- A provider request holds the tool result of a `missed` say. The result
  carries the missed messages.

A `say` against a newer record fails as `missed`, and the tool result
carries the messages that landed. [Durability](durability.md) states the
freshness promise.

**A steer goes to `agent.steer`.** A line that lands during a pass joins
Pi's steering queue as a `[new]` user message. Pi delivers it with the next
provider request. The trace records `steer` with `consumed: true` when the
line joins the queue. `readThrough` moves only when a later provider request
holds it. A line that lands before the first provider request waits until
that request starts. A line held past its pass is recorded as `consumed:
false`, and the next delta carries it.

**The driver decides on another pass.** `shouldRefresh` answers yes when Pi
holds a queued message or the record stands past `readThrough`. The executor
then clears the queues, and the driver runs a pass with the delta. A delta
with no message in it starts no run. The session takes the view as read.

**The activation token limit windows the record.** The driver pages the
record from the tail, keeps the newest messages that fit
`activationTokenLimit`, and keeps the open exchange whole. The limit counts
record text through `estimateTokens`. It does not count the system prompt,
the tool schemas, or the model output. It does not compare with the context
window of the model. The stub model of a scripted stream reports a window of
one million tokens. The executor does no compaction. With `memory: 'seat'`
the kept transcript grows for as long as the process lives.

## How room tools reach the harness

**The room tools are Pi tools bound to the activation.** An ordinary
activation receives `say`, `seat`, and `unseat`, and then the tools of the
definition. A closing activation receives only `say`; the room turns that
say into the summary.

- **`say`** commits a `said` intent with `readThrough` and the tool call id
  as its key. It accepts `text`, `to`, and `refs`.
- **`seat` and `unseat`** commit a membership intent with the tool call id
  as the key.
- **A `refused` answer** raises the room's message as a tool error.
- **A `missed` answer** raises a tool error that lists the new messages.
- **An `unknown` or `stale` answer** aborts the activation. The tool result
  ends the run, because the message may already stand on the record.

`say` is the room's own event. It raises no `tool_execution_start` event.

### The seat transcript audit

**Each seat keeps a Pi session as its audit.** `seatSessionId(room, seat)`
returns a JSON string, `["ambion/seat-session", room, seat]`. `pi-journal`
stores the session in the `ambion/pi-session` namespace of the host storage.
The record and the trace use other journal names in the same storage. They
can share one database.

- **An `ambion/activation` entry opens a transcript.** The executor writes
  it when it audits from message zero. That happens in each activation with
  `memory: 'activation'`. With `memory: 'seat'` it happens in the first
  activation after a start or a restart. An activation that continues a
  kept transcript writes no marker.
- **Each message lands once.** A later pass of the activation appends only the
  messages the audit does not hold.
- **A write retries once.** After the second failure the executor emits
  `audit_error` with the agent, the activation, and the error. It does not
  fail the activation.
- **No durable backlog exists.** Unconfirmed transcript data can be lost on a
  process failure. [Deployment](deployment.md) states the procedure. The
  Cloudflare adapter reports the event through `onSeatEvent`.

The audit is a record of what the model did. The room never reads it.

## Tools and bundles an agent can add

**A tool is an `AmbionTool`.** `defineTool` builds one from a TypeBox schema.
The executor wraps it as a Pi tool. Its context carries `agent`, `signal`,
`callId`, `onUpdate`, `room`, `activation`, and `exchange`. A string result
becomes text content. A thrown error becomes a Pi tool error.

**`fromPiTool` adapts a native Pi tool.** It keeps the name, the schema,
`prepareArguments`, and `executionMode`, and passes the call id, the signal,
and the update callback through.

**A bundle adds tools and guidance.** `bundles: [shared.tools()]` adds the
tools of a resource, such as the workspace. The kernel flattens bundles at
definition time and rejects two tools with one name. The guidance of every
bundle follows the speaking policy in the system prompt. See
[Resources](resources.md) and [Workspace](workspace.md).

## Policy and the trust boundary

**Pi runs every tool on the host.** A tool has the privileges of the host
process. Pi has no permission layer, no approval step, and no sandbox. The
definition is the whole policy: a tool that the definition omits does not
exist for the model.

**What the model sees.** The model sees the system prompt, the record, and
the tools. An ordinary activation lists `say`, `seat`, `unseat`, and the tools
of the definition. A closing activation lists `say` only. The model sees no
environment variable and no key.

**What the host holds.** The registry stream reads the provider key in the
host process, and it sends the key to the provider only. A tool that reads
`process.env` or the disk gives the model what it reads. Give a tool the
narrowest reach that the job needs, and use a workspace backend for files.

**The audit is a second copy of the transcript.** It holds prompts, tool
inputs, and tool outputs in the storage of the host. Treat it as sensitive as
the record. See [Deployment](deployment.md).

## Memory modes

**`memory: 'activation'` is the default.** Each activation builds a fresh Pi
agent. The seat remembers nothing between activations, and the release
records no session.

**`memory: 'seat'` keeps one transcript for the seat.** The executor keeps
the transcript of the last activation that did not fail. The next activation
builds its agent over that transcript. Its first prompt is the delta: the
record beyond the position the transcript read through. A closing activation
reads the whole view. `readThrough` starts at the position the transcript read.
Freshness still governs speech.

**The release records the seat session.** The room stores
`{ harness: 'pi', id }` on the `ended` entry. The id is `seatSessionId(room,
seat)`. The room never reads it. The kept transcript lives in the process. A
restart begins a fresh transcript, and the first activation after it reads
the whole view and appends to the same audit session. See
[Durability](durability.md#storage-compatibility).

## The step mapping

**Pi events become the shared steps.** The table lists what the Pi executor
records. The driver writes `pass`, `room`, and `end`.

| Step          | Source in Pi                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `thinking`    | `thinking_delta` events, then `thinking_end`. A block the stream did not send arrives whole.            |
| `text`        | `text_delta` events, then `text_end`. A block the stream did not send arrives whole.                    |
| `tool_call`   | `tool_execution_start`, with the call id, the tool name, and the arguments.                             |
| `tool_result` | `tool_execution_end`, with the result. A failed call adds `error` with the text of the result.          |
| `steer`       | A line that joined the queue is `consumed: true`. A line dropped before a request is `consumed: false`. |
| `usage`       | The end of each assistant message.                                                                      |
| `approval`    | Never. Pi has no approval step.                                                                         |

A redacted thinking block adds no step. The trace policy of the definition
sets how much of `thinking` and tool output the journal keeps.

## Usage and cost

**Pi records one `usage` step for each assistant message.** The step holds
`input`, `output`, `cacheRead`, `cacheWrite`, and `cost`. Pi computes `cost`
from the price table of the model in the registry. A stub model has a zero
price table.

**The driver sums the steps at release.** The release entry of an activation
carries the sum, and a closed exchange read carries the sum of its
activations. The known limits:

- An end that the room writes (`expired`, `revoked`, `abandoned`) carries no
  usage. The sum omits what those attempts spent.
- The trace caps do not cut the sum. The driver adds each step before the
  cap applies.
- A provider that reports no usage gives zeros.

## Failure classification

**The executor sorts a failure into `permanent` and `transient`.** A
permanent failure ends the activation in one attempt. A transient failure
retries to the cap of the room. [Durability](durability.md#permanent-and-transient-failure)
states the rule.

| Failure                                                             | Cause                                    |
| ------------------------------------------------------------------- | ---------------------------------------- |
| An error message with credit or authentication text                 | `permanent`                              |
| A provider diagnostic with status 400, 401, 402, 403, 404, 405, 422 | `permanent`                              |
| Any other error message from the provider                           | `transient`                              |
| An error of the executor: a lost room call, an unknown model        | `transient`                              |
| A last message that stopped at a length limit                       | None. The pass reports `stop: 'length'`. |

The executor reads a status only from a provider diagnostic. A rate limit
names a token count that reads like a status, so free text never gives one.
The last diagnostic with a status wins. An unknown model id fails on the first
pass as `transient`, so the room retries it to the cap.

**An audit failure never changes the outcome.** It raises `audit_error`,
and the activation still succeeds.

## Testing

**A scripted stream tests the room with no model and no key.**
`@ambionframework/pi/testing` exports `scripted`, `byAgent`, `speak`,
`quiet`, `callTool`, `seat`, `isClosing`, `contextText`, `toolNames`, and
`toolResultTexts`.

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
  execution: piExecution({ stream }),
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

**What the scripted tier proves.** It proves the room, the freshness rules,
the steer path, the audit, the trace steps, and the failure paths. Tests in
`packages/pi/test` cover each, and `packages/claude/test/mixed-room.test.ts`
runs a Pi seat beside a Claude seat.

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
| Each seat fails at once with `no_execution`                         | The room has no `execution`. Pass `piExecution()` to the room or the runtime.                              |
| `Unknown model '...' for agent '...': expected 'provider/model-id'` | The id has no provider prefix, or the registry lacks it. The failure is transient, so the room retries it. |
| The seat is abandoned after one attempt                             | A permanent failure. Read the `error` event. Check `<PROVIDER>_API_KEY` and the credit of the account.     |
| `The Pi executor cannot run an executor of kind 'claude'`           | A Claude seat ran under `piExecution()`. Route with `composeExecutions`.                                   |
| `An agent estimateTokens needs an activationTokenLimit.`            | `estimateTokens` is set with no limit.                                                                     |
| An `audit_error` event                                              | The audit write failed twice. Check the storage. The activation is unaffected.                             |
| The agent never speaks                                              | Silence is legal. Read the trace with `readActivation` to see the thinking and the tool calls.             |
| A say returns `Not delivered — the room moved`                      | The freshness rule refused a say against newer record. The model reads the new messages and decides again. |
| A steer shows `consumed: false`                                     | The pass ended before the next provider request. The next delta carries the line.                          |
| The first activation after a restart re-reads the record            | `memory: 'seat'` keeps the transcript in the process. A restart starts a new one.                          |
| The activation ends with `stop: 'length'`                           | The last model message hit a length limit. Shorten the record with `activationTokenLimit`.                 |
