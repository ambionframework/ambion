# @ambionframework/simulator

`@ambionframework/simulator` runs evals on an Ambion room. An actor plays a
person, one exchange at a time, and `simulate` returns a simulation that
checks in code read. [Simulator](../../docs/simulator.md) holds the design.

```sh
npm install @ambionframework/ambion @ambionframework/pi @ambionframework/simulator
```

```ts
import { defineAgent, definePerson, startRoom } from '@ambionframework/ambion';
import { pi } from '@ambionframework/pi';
import { scriptedActor, simulate } from '@ambionframework/simulator';

const weather = defineAgent({
  name: 'weather',
  identity: 'Site weather desk.',
  executor: pi({ model: 'anthropic/claude-sonnet-5', instructions: 'Answer with the forecast.' }),
});
const priya = definePerson({ name: 'priya', identity: 'Site manager.' });
const room = await startRoom({ name: 'pour', agents: [weather] });

const simulation = await simulate(room, {
  person: priya,
  actor: scriptedActor(['Can we pour concrete on Thursday?']),
  messages: 1,
});

console.log(simulation.ended, simulation.exchanges[0]?.view.outcome);
await room.stop();
```

**The loop drives a room that the test started.** Each message opens one
exchange. The loop waits for the close and the summary under one deadline,
`exchangeMs`, and it ends with `stopped`, `limit`, `timeout`, or `failed`.
The test stops the room.

**`agentActor` plays a brief on a model, and `agentJudge` grades a simulation.**
Both take the options of an agent definition, such as `workspace.tools()`,
and run on Pi's `AgentHarness`. An eval with either one is a live test,
and it costs money on each run.
