# The Pi executor

`@ambionframework/pi` runs Ambion agents on Pi. This page holds what is
specific to the Pi adapter. [Executors](executors.md) holds the shared
contract: the activation flow, the room tools, exchange continuity, failure
classification, the step vocabulary, and the trace.
[The Claude guide](claude.md) covers a second shipped family, and [the
Codex guide](codex.md) a third. [The
README](../README.md) holds the positioning.

## What it is and when to use it

**Pi owns the model loop and the tools. The caller owns the process.**
`pi()` defines the executor of one agent. `piExecution()` gives a room or a
runtime the services that run it. The package holds Pi and the model
registry. The kernel names no model library.

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
validates the shared fields. Pi adds `model`.

| Option                 | Required | Default                      | Meaning                                                                  |
| ---------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------ |
| `instructions`         | Yes      | None                         | The private guidance of the agent.                                       |
| `model`                | Yes      | None                         | A Pi model id, `provider/model-id`.                                      |
| `tools`                | No       | None                         | The tools of the agent, from `defineTool` or `fromPiTool`.               |
| `bundles`              | No       | None                         | Tool bundles. Their guidance joins the prompt after the speaking policy. |
| `speaking`             | No       | `DEFAULT_GUIDANCE`           | The speaking policy. It replaces the default.                            |
| `activationTokenLimit` | No       | The whole record             | The token limit of the record one activation reads. A positive integer.  |
| `estimateTokens`       | No       | `Math.ceil(text.length / 4)` | Counts tokens against the limit. It needs `activationTokenLimit`.        |

**`piExecution(options)` takes one option.**

| Option   | Default                | Meaning                                                                           |
| -------- | ---------------------- | --------------------------------------------------------------------------------- |
| `stream` | The Pi registry stream | A Pi `StreamFn`. A custom stream makes the model resolve to a stub (see Testing). |

The runtime supplies the clock, the call limits, the trace limits, the
logger, and the transport. `pi()` throws at definition time when
`estimateTokens` has no `activationTokenLimit`, and when the limit is not a
positive integer.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position and the record window. Pi adds these facts.

**One Pi agent serves one activation.** The executor resolves the model,
binds the tools, and builds the agent. The Pi transcript of the activation
stays whole. The agent runs with `thinkingLevel: 'off'`, and no option
changes it.

**The system prompt is the mechanism and the agent part.** The executor
sends `mechanism` and `agent` from `renderActivation` as the system prompt.
The `context` part is the first user message. Each later pass replaces the
system prompt with the one of the view in hand.

**`readThrough` follows the provider request.** The position is the highest
contiguous record position in provider input. A provider request holds the
initial prompt, a delta, or a steered line. The room tool answers also move
the position; see [Executors](executors.md#how-an-activation-runs).

**A steer goes to `agent.steer`.** A line that lands during a pass joins
Pi's steering queue as a `[new]` user message. Pi delivers it with the next
provider request. The trace records `steer` with `consumed: true` when the
line joins the queue. `readThrough` moves only when a later provider request
holds it. A line that lands before the first provider request waits until
that request starts.

**`shouldRefresh` also answers yes when Pi holds a queued message.** The
executor then clears the queues, and the driver runs a pass with the delta.
A delta with no message in it starts no run. The session takes the view as
read.

**The stub model of a scripted stream reports a window of one million
tokens.**

**The Pi executor does no compaction.** A kept transcript grows for as long
as its exchange stays open.

## How room tools reach the harness

[Executors](executors.md#the-room-tools) states the three tools, the commit
key, and the room answers.

**The room tools are Pi tools bound to the activation.** Pi calls them in
the same process, so it needs no transport.

**An `unknown` or `stale` answer ends the run.** Pi aborts the activation
and stands the seat down. The tool result names why the turn ended, and no
further pass follows.

## Tools and bundles an agent can add

[Definitions and tools](agent.md#tools) states `AmbionTool`, `defineTool`,
and how a bundle adds tools and guidance. Pi adds these facts.

**The executor wraps a tool as a Pi tool.** Its context carries `agent`,
`signal`, `callId`, `onUpdate`, `room`, `activation`, and `exchange`. A
string result becomes text content. A thrown error becomes a Pi tool error.

**`fromPiTool` adapts a native Pi tool.** It keeps the name, the schema,
`prepareArguments`, and `executionMode`, and passes the call id, the signal,
and the update callback through.

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

## Exchange continuity

[Executors](executors.md#exchange-continuity) states the rule, the recorded
session, and the fresh start.

**The executor keeps a transcript through its last pass that did not
fail.** The id of the activation that began the transcript names it, and
the release records `{ harness: 'pi', id }`. An activation continues the
transcript only when `spec.resume` names that id. Its agent starts over the
transcript, and its first prompt is the delta: the record beyond the
position the transcript read through. A delta with no message starts no
run. A closing activation reads the whole view. `readThrough` starts at
the position the transcript read.

**The seat keeps the two latest transcripts.** The open exchange can run
beside the summary of the exchange before it, and each continues its own
transcript.

**The transcript lives in the process.** Pi writes no transcript to the
storage. A restart loses it, and the first activation after the restart
reads the whole view. [The trace](executors.md#the-trace-log) shows the
host's logger what the model did.

## The step mapping

[Executors](executors.md#the-step-vocabulary) holds the ten step kinds and
the trace policy. The table below gives the Pi source of each step. The
driver writes `pass`, `room`, and `end`.

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
the steer path, exchange continuity, the trace steps, and the failure paths. Tests in
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
| Each seat fails at once with `no_execution`                         | No loaded package serves the kind of the seat. Import the executor package, or pass `piExecution()`.       |
| `Unknown model '...' for agent '...': expected 'provider/model-id'` | The id has no provider prefix, or the registry lacks it. The failure is transient, so the room retries it. |
| The seat is abandoned after one attempt                             | A permanent failure. Read the `error` event. Check `<PROVIDER>_API_KEY` and the credit of the account.     |
| `The Pi executor cannot run an executor of kind 'claude'`           | A Claude seat ran under `piExecution()`. Route with `composeExecutions`.                                   |
| `An agent estimateTokens needs an activationTokenLimit.`            | `estimateTokens` is set with no limit.                                                                     |
| The agent never speaks                                              | Silence is legal. Pass a `logger` to `createRuntime` and read the thinking and the tool calls there.       |
| A say returns `Not delivered — the room moved`                      | The freshness rule refused a say against newer record. The model reads the new messages and decides again. |
| A steer shows `consumed: false`                                     | The pass ended before the next provider request. The next delta carries the line.                          |
| The first activation after a restart re-reads the record            | The kept transcript lives in the process. A restart starts a new one.                                      |
| The activation ends with `stop: 'length'`                           | The last model message hit a length limit. Shorten the record with `activationTokenLimit`.                 |
