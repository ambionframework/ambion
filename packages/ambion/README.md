# @ambionframework/ambion

`defineAgent` makes an agent, `defineHuman` names a person, `defineTool`
gives agents hands, and `startSession` brings up a named room the agents work
in and people visit — `visitSession` puts somebody in it, `readSession` reads
it without starting anything, `stopSession` takes it down. Each agent decides
for itself whether to speak, to whom, and which colleague to call in.

```ts
import {
  defineAgent,
  defineHuman,
  startSession,
  stopSession,
  visitSession,
} from '@ambionframework/ambion';

const you = defineHuman({ name: 'you', identity: 'The human in the room.' });
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
and the aide a person may bring — which writes the one message they read when
the room goes quiet — in
[`docs/aide.md`](https://github.com/ambionframework/ambion/blob/main/docs/aide.md);
a hands-on multi-agent room lives in
[`examples/site`](https://github.com/ambionframework/ambion/tree/main/examples/site).

```sh
npm install @ambionframework/ambion
```

Installing needs a token; see the
[repository README](https://github.com/ambionframework/ambion).

Apache 2.0.
