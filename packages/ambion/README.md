# @ambionframework/ambion

**Ambion is a collaboration kernel for independently owned agents and the
people they serve.** It gives domain agents a shared journal, rules for
participation, and a reliable boundary for contributing to a conversation.

An agent owns its instructions, model, tools, and domain expertise. A room
lets those agents work together. An optional assistant selects specialists
and consolidates their work for a person. Applications own domain data and
tool resources.

## Install

Use Node **22.19 or later** and ESM. Installation requires a GitHub Packages
read token and registry configuration from the
[repository README](https://github.com/ambionframework/ambion#install).

```sh
npm install @ambionframework/ambion
```

The main library includes its journal dependency. Add
`@ambionframework/workspace` when agents need optional filesystem tools.
Model execution uses Pi and needs credentials for the chosen provider.

## Use

This example uses the current API. The optional assistant has selection and
summary duties; the specialist owns domain reasoning.

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
  model: 'anthropic/claude-sonnet-4-5',
});
const assistant = defineAgent({
  name: 'assistant',
  identity: 'Selects specialists and consolidates their work.',
  instructions: 'Preserve the decision and the facts that support it.',
  model: 'anthropic/claude-sonnet-4-5',
});

const room = await startRoom({
  name: 'delivery',
  goal: 'Check delivery promises against stock.',
  assistant,
  agents: [inventory],
});

try {
  const visit = await room.visit(you);
  const exchange = await visit.send({
    text: 'We have 12 units in stock. Can we promise an order for 15?',
  });
  const response = await exchange.response();
  if (response) {
    console.log(response.text);
  } else {
    for (const message of await exchange.messages()) {
      if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
    }
  }
  await visit.leave();
} finally {
  await room.stop();
}
```

`exchange.messages()` waits for the fixed discussion. `exchange.response()`
waits for its summary or a terminal result without one. Revoked or abandoned summary work rejects the response wait.
A room without an
assistant still closes exchanges and exposes the discussion. A single answer
can require no summary even when an assistant is present.

Use `defineTool` for an agent's ordinary typed tools. Put reusable tool bundles
in the separate `bundles` field. The current `agents` list supplies every
ordinary definition. The optional `seats` map selects initial members;
definitions absent from that map form the reserve.
Attention controls idle agents; active ordinary agents receive new context.
An agent can finish silently, and the room refuses speech based on stale context.

Adapt a native Pi tool with `fromPiTool(nativePiTool)` before you put it in
`tools` or a bundle. The adapter gives the executor one typed tool shape.

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
participants can review the original discussion through `exchange.messages()`.
The journal retains the complete history.

**0.1.0 remains a release target.** Membership API changes and package
extraction remain pending. The
[documentation index](https://github.com/ambionframework/ambion/blob/main/docs/README.md)
distinguishes current behavior from the release plan.

## Read more

- [Design contracts](https://github.com/ambionframework/ambion/tree/main/docs)
- [Deployment and recovery](https://github.com/ambionframework/ambion/blob/main/docs/deployment.md)
- [Multi-agent site example](https://github.com/ambionframework/ambion/tree/main/examples/site)
- [0.1.0 release scope](https://github.com/ambionframework/ambion/blob/main/planning/release-0.1.0.md)

Apache 2.0.
