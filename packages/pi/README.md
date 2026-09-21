# @ambionframework/pi

**Run Ambion agents on Pi.** `pi()` defines the executor of an agent.
`piExecution()` gives a runtime or a room the services that run it. The
kernel, `@ambionframework/ambion`, imports no model library. This package holds
Pi, the model registry, and the audit of each seat's transcript. The
[guide](https://github.com/ambionframework/ambion/blob/main/docs/pi.md) holds
every detail. [Ambion](https://ambionframework.com) is a collaboration kernel
for agents and humans.

## When to use it

- **The loop runs in the host process.** Pi owns the model loop and the tools.
- **Any provider that the Pi registry lists.** The model id is
  `provider/model-id`.
- **Steering during a pass.** A line that lands mid-activation reaches the
  model through `agent.steer`.
- **Deterministic tests.** A scripted stream replaces the provider.

Use [`@ambionframework/claude`](https://github.com/ambionframework/ambion/blob/main/docs/claude.md)
when the agent needs the built-in tools of Claude Code.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

Every package needs Node 26.4 or newer. Until the packages publish to npmjs,
installation needs a GitHub Packages read token; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

**The registry reads the key from the environment.** The variable is the
upper-case provider of the model, with each `-` replaced by `_`, and the
suffix `_API_KEY`. The id `anthropic/claude-sonnet-5` reads
`ANTHROPIC_API_KEY`.

## Example

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

**Pass `execution` to a room or to a runtime.** `startRoom` and `resumeRoom`
take it for one room run. `createRuntime` takes it for every room of the
runtime. A room whose seats run on more than one family passes
`composeExecutions({ pi, claude })` from `@ambionframework/ambion/hosting`.

## Options

| Option                 | Default                      | Meaning                                                |
| ---------------------- | ---------------------------- | ------------------------------------------------------ |
| `instructions`         | Required                     | The private guidance of the agent.                     |
| `model`                | Required                     | A Pi model id, `provider/model-id`.                    |
| `tools`, `bundles`     | None                         | The tools of the agent and the bundles that add tools. |
| `speaking`             | `DEFAULT_GUIDANCE`           | The speaking policy. It replaces the default.          |
| `activationTokenLimit` | The whole record             | The token limit of the record one activation reads.    |
| `estimateTokens`       | `Math.ceil(text.length / 4)` | Counts tokens against the limit. It needs the limit.   |
| `memory`               | `'activation'`               | `'activation'` or `'seat'`.                            |

`piExecution({ stream })` takes one option. Without a `stream`, the Pi
registry answers. A scripted `stream` makes a room deterministic, and the
model then resolves to a stub.

## How an activation runs

**One Pi agent serves each activation.** The first pass builds the agent from
the whole view. A later pass prompts the same agent with the messages that
landed beyond what it has read.

**Freshness follows the provider request.** `readThrough` advances when a
provider request holds the record, so the room refuses a say against a stale
draft with the messages it missed. A line that lands mid-activation joins
Pi's steering queue through `agent.steer`.

**Room tools are Pi tools.** An ordinary activation receives `say`, `seat`,
and `unseat`, and then the tools of the agent. A closing activation receives
`say` only.

## Policy and the trust boundary

**Every tool runs on the host.** Pi has no permission layer and no sandbox.
The definition is the whole policy. The model sees no environment variable and
no key. The registry stream reads the key in the host process.

## Memory

**`memory: 'activation'` builds a fresh agent for each activation.**
**`memory: 'seat'` keeps the transcript of the last activation that did not
fail,** and the next activation prompts it with the delta. The release records
`{ harness: 'pi', id }`. The kept transcript lives in the process, so a
restart reads the whole view once.

## Audit, steps, usage, and failures

**Each seat keeps a Pi session as its audit.** `seatSessionId(room, seat)`
names it. The audit failure raises `audit_error` and changes no outcome.

**Steps.** The executor records `thinking`, `text`, `tool_call`,
`tool_result`, `steer`, and `usage`. It records no `approval`.

**Usage.** One `usage` step follows each assistant message, with the cost from
the price table of the model.

**Failures.** Credit or authentication text, and a diagnostic status of 400,
401, 402, 403, 404, 405, or 422, are permanent. Every other failure is
transient.

## Test

`@ambionframework/pi/testing` exports a scripted stream and its helpers:
`scripted`, `byAgent`, `speak`, `quiet`, `callTool`, `seat`, `isClosing`,
`contextText`, `toolNames`, and `toolResultTexts`.

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
  console.log((await exchange.waitForClose()).filter(isSpoken).map((message) => message.text));
} finally {
  await room.stop();
}
```

A scripted stream sends no provider payload. It shows nothing about the
registry, the price tables, or a real model. The live scenarios of
`packages/ambion/test/live` run Pi on a real provider through `pnpm test:live`.

## Exports

| Export                                        | Use                                                       |
| --------------------------------------------- | --------------------------------------------------------- |
| `pi(options)`                                 | The executor of an agent definition                       |
| `fromPiTool(tool)`                            | Adapt a native Pi tool to an Ambion tool                  |
| `piExecution({ stream })`                     | The `execution` value for `startRoom` and `createRuntime` |
| `createPiExecutor`, `createExecutionServices` | The parts for a host that runs seats apart from the room  |
| `seatSessionId(room, seat)`                   | The id of the audit session of one seat                   |
| `stubModel`                                   | The model that a custom stream receives                   |

## Troubleshooting

- **`no_execution`.** The room has no `execution`. Pass `piExecution()`.
- **`Unknown model`.** The id needs the form `provider/model-id` and a
  provider that the registry lists. The failure is transient, so the room
  retries it to the cap.
- **Abandoned after one attempt.** A permanent failure. Check
  `<PROVIDER>_API_KEY` and the credit of the account.
- **`audit_error`.** The audit write failed twice. Check the storage.

The [guide](https://github.com/ambionframework/ambion/blob/main/docs/pi.md#troubleshooting)
lists more causes.
