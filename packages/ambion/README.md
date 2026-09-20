# @ambionframework/ambion

**Ambion is a collaboration kernel for agents and humans.** A room is a
shared journal with rules for taking part. People ask questions and read
results. Agents speak when they have something to add and stay silent when
they do not. The kernel keeps the record and the rules. A restart loses
nothing.

An agent owns its instructions, model, tools, and domain expertise. A room
lets those agents work together. An optional summary records a closed human
exchange for its owner. Applications own domain data and tool resources.

## Install

Use Node **26.4 or later** and ESM. Until the packages publish to npmjs,
installation needs a GitHub Packages read token and the registry
configuration in [the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

```sh
npm install @ambionframework/ambion
```

The main library includes its journal dependency. Add
`@ambionframework/workspace` when agents need optional filesystem tools.
Add `@ambionframework/assistant` for the default assistant implementation.
Model execution comes from an executor package. `@ambionframework/pi` is the
Pi executor: pass `execution: piExecution()` to `startRoom` or `createRuntime`.
It needs credentials for the chosen provider.

## Use

This example uses the current API. Every executable agent belongs in `agents`.
The optional `summary` field names an ordinary agent that may write a closing
summary.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';

const you = defineHuman({
  name: 'you',
  identity: 'Coordinates customer deliveries.',
  preferences: 'Lead with the constraint. Four sentences at most.',
});
const inventory = defineAgent({
  name: 'inventory',
  identity: 'Checks stock constraints.',
  instructions: 'Use supplied stock facts. State a constraint only when it changes the answer.',
  model: 'anthropic/claude-sonnet-5',
});
const editor = defineAgent({
  name: 'editor',
  identity: 'Consolidates the closed exchange.',
  instructions: 'Preserve the decision and the facts that support it.',
  model: 'anthropic/claude-sonnet-5',
});

const room = await startRoom({
  name: 'delivery',
  goal: 'Check delivery promises against stock.',
  summary: 'editor',
  agents: [inventory, editor],
});

try {
  const visit = await room.visit(you);
  const exchange = await visit.send({
    text: 'We have 12 units in stock. Can we promise an order for 15?',
  });
  const response = await exchange.waitForSummary();
  if (response) {
    console.log(response.text);
  } else {
    for (const message of await exchange.waitForClose()) {
      if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
    }
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

`exchange.waitForClose()` waits for the fixed discussion. `exchange.waitForSummary()`
waits for its summary or a terminal result without one. The writer may decline,
and a room without a configured writer still closes exchanges and exposes the
discussion. Every closed human exchange is eligible when its writer is seated.

`room.read()` returns current messages, participants, and exchange states.
Use `readRoom(name, { runtime })` or `readExchange(name, from, { runtime })`
to inspect durable state without a live handle. Reads never wait for completion.

Use `startRoom({ assistant, agents })` to register an assistant definition,
seat it at `broadcast`, and select it as the summary writer. Supply specialists
in `agents`; omit the assistant from that list. An explicit `seats: {}` starts
only the assistant. Omitting `seats` starts all defined agents at `broadcast`.
See the [assistant contract](https://github.com/ambionframework/ambion/blob/main/docs/assistant.md).

Use `defineTool` for an agent's ordinary typed tools. Put reusable tool bundles
in the separate `bundles` field. The current `agents` list supplies every
ordinary definition. The optional `seats` map sets initial members; definitions
absent from that map form the reserve. If omitted, every agent starts at
`broadcast`. Any live agent can use `seat` and `unseat`.
Attention controls idle agents; active agents receive new context.
An agent can finish silently, and the room refuses speech based on stale context.

Adapt a native Pi tool with `fromPiTool(nativePiTool)`, from
`@ambionframework/pi`, before you put it in `tools` or a bundle. The adapter
gives the executor one typed tool shape.

## Persistence and limits

The journal records active collaboration and its history. Hosts can recover
pending work from confirmed entries. The default storage is in memory;
persistent services must supply storage, executable definitions, and recovery
procedures. Workspace data has its own persistence contract.

Tools can act before speech commits. Applications own effect idempotency.
Room history and model input can grow, and continuing contributions can keep
an exchange open. `abort()` and `stop()` affect the room. Subscriptions belong
to a running host.

**Summaries compact later activations.** Once a closed exchange has a summary,
agent context uses it in place of the covered source messages. Human
participants can review the original discussion through `exchange.waitForClose()`.
The journal retains the complete history.

**0.1.0 remains a release target.** The
[documentation index](https://github.com/ambionframework/ambion/blob/main/docs/README.md)
distinguishes current behavior from the release plan.

## Read more

- [Design contracts](https://github.com/ambionframework/ambion/tree/main/docs)
- [Deployment and recovery](https://github.com/ambionframework/ambion/blob/main/docs/deployment.md)
- [Workbench example](https://github.com/ambionframework/ambion/tree/main/examples/workbench)
- [0.1.0 plan](https://github.com/ambionframework/ambion/blob/main/planning/next.md)

Apache 2.0.
