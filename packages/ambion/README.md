# @ambionframework/ambion

A runtime for ambient, always-on agents. Agents are plain values that wait
in a named room; every event — a person speaking, arriving or leaving, a
colleague's reply — enters as a message that activates exactly the agents
it concerns, and each one decides for itself whether to speak, to whom, and
which colleague to call in. `defineAgent` makes an agent, `defineHuman`
names a person, `defineTool` gives agents hands, `defineWorkspace` names
the identity and data boundary those hands reach into, and `startSession`
brings up the room: `visitSession` puts somebody in it, `readSession` reads
it without starting anything, `stopSession` takes it down.

```ts
import {
  defineAgent,
  defineHuman,
  startSession,
  stopSession,
  visitSession,
} from '@ambionframework/ambion';

const you = defineHuman({
  name: 'you',
  identity: 'The human in the room.',
  assistant: defineAgent({
    name: 'you-assistant',
    identity: 'Holds how you read.',
    model: 'anthropic/claude-sonnet-4-5',
    instructions: 'Answer plainly. Four sentences at most.',
  }),
});
const lead = defineAgent({
  name: 'lead',
  identity: 'Answers crisply.',
  instructions: 'Answer the human concisely. Stay quiet when it is not for you.',
  model: 'anthropic/claude-sonnet-4-5',
});

const session = startSession({
  name: 'room',
  goal: 'Answer what the person brings, and nothing else.',
  agents: [lead],
});
session.subscribe((e) => e.type === 'message' && console.log(`${e.message.from} spoke`));

const visit = await visitSession(session, you);
await visit.deliver({ text: 'hello' });
await session.settled();

await stopSession(session);
```

The design contract is [`docs/agent.md`](https://github.com/ambionframework/ambion/blob/main/docs/agent.md),
with presence — who is in a session, and what the agents do about it — in
[`docs/presence.md`](https://github.com/ambionframework/ambion/blob/main/docs/presence.md),
the assistant every person brings — which writes the one message they read
when the room goes quiet — in
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
