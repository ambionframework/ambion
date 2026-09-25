# @ambionframework/simulator

`@ambionframework/simulator` runs evals on an Ambion room. An actor plays a
person, one exchange at a time, and `simulate` returns a run that checks in
code read. [Simulator](../../docs/simulator.md) holds the design. The example
below elides the definition of the `weather` agent.

```sh
npm install @ambionframework/ambion @ambionframework/simulator
```

```ts
import { defineHuman, startRoom } from '@ambionframework/ambion';
import { scriptedActor, simulate } from '@ambionframework/simulator';

const priya = defineHuman({ name: 'priya', identity: 'Site manager.' });
const room = await startRoom({ name: 'pour', agents: [weather] });

const run = await simulate(room, {
  person: priya,
  actor: scriptedActor(['Can we pour concrete on Thursday?']),
  exchanges: 1,
});

console.log(run.ended, run.exchanges[0]?.view.outcome);
await room.stop();
```

**The loop drives a room that the test started.** Each message opens one
exchange. The loop waits for the close and the summary under one deadline,
`exchangeMs`, and it ends with `stopped`, `limit`, `timeout`, or `failed`.
The test stops the room.

**`agentActor` plays a brief on a model, and `agentJudge` grades a run.**
Both take the options of an agent definition, such as `workspace.tools()`,
and run on Pi's `AgentHarness`. An eval with either one is a live test,
and it costs money on each run.
