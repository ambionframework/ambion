# @ambionframework/pi

**Run Ambion agents on Pi.** `pi()` defines the executor of an agent.
`piExecution()` gives a runtime or a room the services that run it. The
kernel, `@ambionframework/ambion`, imports no model library. This package holds
Pi and the model registry. The
[guide](https://github.com/ambionframework/ambion/blob/main/docs/pi.md) holds
every detail. [Ambion](https://ambionframework.com) is a collaboration kernel
for agents and humans.

## When to use it

- **The loop runs in the host process.** Pi's `AgentHarness` owns the model
  loop, the session, its persistence and its compaction.
- **Any provider that the Pi registry lists.** The model id is
  `provider/model-id`.
- **Steering during a pass.** A line that lands mid-activation reaches the
  model through the steer queue of the harness lane.
- **Deterministic tests.** A scripted stream replaces the provider.

Use [`@ambionframework/claude`](https://github.com/ambionframework/ambion/blob/main/docs/claude.md)
when the agent needs the built-in tools of Claude Code.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/pi
```

Every package needs Node 22.19 or newer. The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

**The registry reads the key from the environment.** The variable is the
upper-case provider of the model, with each `-` replaced by `_`, and the
suffix `_API_KEY`. The id `anthropic/claude-sonnet-5` reads
`ANTHROPIC_API_KEY`.

## Example

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

**A room with no `execution` runs each Pi seat on the default Pi
execution.** Importing the package registers it. A host that needs a
scripted stream, custom storage, a transport, or limits passes
`piExecution(options)` to a room or to `createRuntime`.

## Options

| Option                 | Default                       | Meaning                                                |
| ---------------------- | ----------------------------- | ------------------------------------------------------ |
| `instructions`         | Required                      | The private guidance of the agent.                     |
| `model`                | Required                      | A Pi model id, `provider/model-id`.                    |
| `tools`, `bundles`     | None                          | The tools of the agent and the bundles that add tools. |
| `speaking`             | `DEFAULT_GUIDANCE`            | The speaking policy. It replaces the default.          |
| `activationTokenLimit` | The whole record              | The token limit of the record one activation reads.    |
| `estimateTokens`       | `Math.ceil(text.length / 4)`  | Counts tokens against the limit. It needs the limit.   |
| `compaction`           | `DEFAULT_COMPACTION_SETTINGS` | When the harness compacts the session.                 |
| `thinking`             | `off`                         | How much the model reasons, a Pi `ThinkingLevel`.      |

`piExecution({ stream, sessions, sessionDir })` takes three options.
Without a `stream`, the Pi registry answers. A scripted `stream` makes a
room deterministic, and the model then resolves to a stub. `sessionDir`
names the directory on the local disk for the sessions. Without it, every
stream keeps them in `ambion-pi-sessions-<uid>` in the OS temporary
directory, with access for its owner only. `sessions: 'memory'` keeps them
in memory, two for each room and seat, as a test does.

## How an activation runs

**One Pi `AgentHarness` serves each activation.** The first pass opens the
session and attaches the harness, and prompts it with the whole view. A
later pass prompts the same harness with the messages that landed beyond
what it has read.

**Freshness follows the exact provider input.** Each range of the record
goes into the session as a custom message that carries its positions. The
`toProviderMessages` hook reads them from the messages of each provider
request, so the room refuses a say against a stale draft with the messages
it missed. A line that lands mid-activation joins the steer queue of the
lane, and counts when a provider request holds it.

**Room tools are harness tools.** An ordinary activation receives `say`,
`seat`, and `unseat`, and then the tools of the agent. A closing activation
receives `say` only. The harness adds no built-in tool, no skill, and no
prompt template.

**The room owns the retries, and the harness compacts.** The harness does
not retry a failed request. It compacts the session when the context nears
the window of the model. A context-overflow error, or a length stop below
the output limit, makes the harness compact once and send the request
again. This happens also when compaction is off.

## Policy and the trust boundary

**Every tool runs on the host.** Pi has no permission layer and no sandbox.
The definition is the whole policy. The model sees no environment variable and
no key. The registry stream reads the key in the host process. On Node, the
session files under `sessionDir` hold the whole transcript, tool output
included, and the executor deletes none of them.

## Exchange continuity

**The release records `{ harness: 'pi', id }`,** where the id names the
activation that began the session. The next activation of the seat in the
same exchange reopens the session and prompts it with the delta. The first
activation in a new exchange begins a fresh session. A session the store
cannot open, or that fails a write, gives way to a fresh one, and the
activation does not fail. On Node the session is a JSONL file under
`sessionDir`, so a restart on the same disk reopens it. A Cloudflare seat keeps its sessions in memory.

## Steps, usage, and failures

**Steps.** The executor records `thinking`, `text`, `tool_call`,
`tool_result`, `steer`, and `usage`. It records no `approval`.

**Usage.** One `usage` step follows each provider request, with the cost from
the price table of the model.

**Failures.** Credit or authentication text, and a diagnostic status of 400,
401, 402, 403, 404, 405, or 422, are permanent. Every other failure is
transient.

## Test

`@ambionframework/pi/testing` exports a scripted stream and its helpers:
`scripted`, `byAgent`, `speak`, `quiet`, `callTool`, `seat`, `isClosing`,
`contextText`, `toolNames`, and `toolResultTexts`. `piExecutorHarness()`
runs the executor suite of `@ambionframework/ambion/conformance` on a
scripted stream, and `scriptOf` maps each plan of the suite to a script.

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
  console.log((await exchange.waitForClose()).filter(isSpoken).map((message) => message.text));
} finally {
  await room.stop();
}
```

A scripted stream sends no provider payload. It shows nothing about the
registry, the price tables, or a real model. The live scenarios of
`packages/ambion/test/live` run Pi on a real provider through `pnpm test:live`.

## Exports

| Export                                          | Use                                                       |
| ----------------------------------------------- | --------------------------------------------------------- |
| `pi(options)`                                   | The executor of an agent definition                       |
| `fromPiTool(tool)`                              | Adapt a native Pi tool to an Ambion tool                  |
| `piExecution({ stream, sessions, sessionDir })` | The `execution` value for `startRoom` and `createRuntime` |
| `createPiExecutor`, `createExecutionServices`   | The parts for a host that runs seats apart from the room  |
| `memorySessions`, `PiSessions`, `SessionScope`  | A store of sessions in memory, and the store contract     |
| `stubModel`                                     | The model that a custom stream receives                   |
| `piExecutorHarness` (`/testing`)                | The executor suite on a scripted stream                   |

## Troubleshooting

- **`no_execution`.** No loaded package serves the kind of the seat. Import the executor package.
- **`Unknown model`.** The id needs the form `provider/model-id` and a
  provider that the registry lists. The failure is transient, so the room
  retries it to the cap.
- **Abandoned after one attempt.** A permanent failure. Check
  `<PROVIDER>_API_KEY` and the credit of the account.

The [guide](https://github.com/ambionframework/ambion/blob/main/docs/pi.md#troubleshooting)
lists more causes.
