# @ambionframework/pi

**Run Ambion agents on Pi.** `pi()` defines the executor of an agent.
`piExecution()` gives a runtime or a room the services that run it. The kernel,
`@ambionframework/ambion`, imports no model library. This package holds Pi,
the model registry, and the audit of each seat's transcript.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';
import { pi, piExecution } from '@ambionframework/pi';

const researcher = defineAgent({
  name: 'researcher',
  identity: 'Checks evidence and states uncertainty.',
  executor: pi({
    instructions: 'Use the supplied evidence. Speak when it changes the answer.',
    model: 'anthropic/claude-sonnet-5',
  }),
});

const room = await startRoom({
  name: 'delivery',
  agents: [researcher],
  execution: piExecution(),
});
```

**Pass `execution` to a room or to a runtime.** `startRoom` and `resumeRoom`
take it for one room run. `createRuntime` takes it for every room of the
runtime. Without a `stream`, Pi's model registry answers and reads the
provider key from `<PROVIDER>_API_KEY`. A scripted `stream` makes a room
deterministic; the model then resolves to a stub.

**One Pi agent serves each activation.** The first pass builds the agent from
the whole view. A later pass prompts the same agent with the messages that
landed beyond what it has read. Pi's provider request marks the record as
read, so a stale draft is still refused.

**Each seat keeps a Pi session as its audit.** `seatSessionId(room, seat)`
names the session. The session holds every turn the model took, under one
`ambion/activation` entry for each activation.

| Export                                        | Use                                                       |
| --------------------------------------------- | --------------------------------------------------------- |
| `pi(options)`                                 | The executor of an agent definition                       |
| `fromPiTool(tool)`                            | Adapt a native Pi tool to an Ambion tool                  |
| `piExecution({ stream })`                     | The `execution` value for `startRoom` and `createRuntime` |
| `createPiExecutor`, `createExecutionServices` | The parts for a host that runs seats apart from the room  |
| `seatSessionId(room, seat)`                   | The id of the audit session of one seat                   |
| `stubModel`                                   | The model that a custom stream receives                   |
