# @ambionframework/ambion

Build applications as independently owned agents collaborating behind one
human-facing assistant. Domain agents wait in a named room and work through
one ordered record; each keeps its own model, tools and workspace, and decides
whether it has anything to add. The assistant selects specialists from the
room's reserve and consolidates multi-agent work when needed, without gaining
general-purpose authority over the application.

`defineAgent` makes an agent, `defineHuman` names a person, `defineTool` gives
agents tools. The `assistant` option designates the agent that selects
specialists and writes summaries through the room's fixed assistant policy.
`startRoom` brings up the room, `room.visit` puts somebody in it,
`readRoom` reads a plain snapshot without starting anything, and
`room.stop()` takes the run down. A visit's `send` returns an exchange handle:
`waitForClose()` waits for the durable close and `response()` waits for the
summary or deliberate absence of one.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';

const you = defineHuman({
  name: 'you',
  identity: 'The human in the room.',
  preferences: 'Answer plainly. Four sentences at most.',
});
const lead = defineAgent({
  name: 'lead',
  identity: 'Answers crisply.',
  instructions: 'Answer the human concisely. Stay quiet when it is not for you.',
  model: 'anthropic/claude-sonnet-4-5',
});
const assistant = defineAgent({
  name: 'assistant',
  identity: 'Consolidates the room’s work for the person who asked.',
  instructions: 'Preserve the decision and the facts it turns on.',
  model: 'anthropic/claude-sonnet-4-5',
});

const room = await startRoom({
  name: 'room',
  goal: 'Answer what the person brings, and nothing else.',
  assistant,
  agents: [lead],
});
room.subscribe((e) => e.type === 'message' && console.log(`${e.message.from} spoke`));

const visit = await room.visit(you);
const exchange = await visit.send({ text: 'hello' });
await exchange.waitForClose();
const response = await exchange.response();
if (response) console.log(response.text);

await room.stop();
```

The design contract is [`docs/agent.md`](https://github.com/ambionframework/ambion/blob/main/docs/agent.md),
with presence — who is in a room, and what the agents do about it — in
[`docs/presence.md`](https://github.com/ambionframework/ambion/blob/main/docs/presence.md),
the room's human-facing assistant — which consolidates an exchange when one
agent message does not already serve — in
[`docs/assistant.md`](https://github.com/ambionframework/ambion/blob/main/docs/assistant.md),
and the workspace an agent's tools reach into in
[`docs/workspace.md`](https://github.com/ambionframework/ambion/blob/main/docs/workspace.md);
a hands-on multi-agent room lives in
[`examples/site`](https://github.com/ambionframework/ambion/tree/main/examples/site).

```sh
npm install @ambionframework/ambion
```

Installing needs a token; see the
[repository README](https://github.com/ambionframework/ambion).

Apache 2.0.
