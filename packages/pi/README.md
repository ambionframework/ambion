# @ambionframework/pi

**Run Ambion agents on Pi.** `pi()` defines the executor of an agent.
`piExecution()` gives a runtime or a room the services that run it. The
Pi harness of `@earendil-works/pi-durable` owns the model loop, the session,
and its compaction in the host process. [Ambion](https://ambionframework.com)
is a collaboration kernel for agents and humans. The kernel,
`@ambionframework/ambion`, imports no model library.

## Install

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/pi
```

The package needs Node 22.19 or newer. The registry reads
`<PROVIDER>_API_KEY` for the provider of the model. A subscription of Claude
Pro and Max or ChatGPT Plus and Pro replaces the key: run `loginPi` once.

## Example

```ts
import {
  createRuntime,
  defineAgent,
  definePerson,
  defineTool,
  startRoom,
} from '@ambionframework/ambion';
import { memoryJournals } from '@ambionframework/journal';
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
  }),
});

const priya = definePerson({ name: 'priya', identity: 'Coordinates deliveries.' });

const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
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

Pass `piExecution()` as `execution` to a room or runtime.

## Options

`pi(options)` takes the options that every executor shares, and these three:

- **`model`.** A Pi model id, `provider/model-id`. Required.
- **`compaction`.** When the harness compacts the session. A partial Pi
  `CompactionPolicy`.
- **`thinking`.** How much the model reasons. A Pi thinking level. The default
  is `off`.

`piExecution({ stream, sessions, sessionDir, credentials })` takes four
options. A scripted `stream` makes a room deterministic. `sessions: 'memory'`
keeps the sessions in memory. `sessionDir` names the directory for the
sessions on the local disk. `credentials` is a Pi `CredentialStore` that
holds subscription sign-ins.

Every tool runs on the host, and the session files under `sessionDir` hold the
whole transcript. `@ambionframework/pi/testing` exports a scripted stream and
`piExecutorFixture`.

## Learn more

The [Pi guide](https://github.com/ambionframework/ambion/blob/main/docs/pi.md) holds the subscriptions, the sessions, the step
mapping, and the troubleshooting. The [executor guide](https://github.com/ambionframework/ambion/blob/main/docs/executors.md)
holds the options, the wiring, the failure classes, and the tests that every
executor shares. Use [`@ambionframework/claude`](https://github.com/ambionframework/ambion/blob/main/docs/claude.md) for the
Claude Code loop on a Claude model.
