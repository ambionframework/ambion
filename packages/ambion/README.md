# @ambionframework/ambion

Four primitives: `defineAgent` makes an agent, `defineHuman` seats a person,
`defineTool` gives agents hands, and `openSession` opens a named room where
all of them meet — each agent deciding for itself whether to speak, to whom,
and which colleague to call in.

```ts
import { defineAgent, defineHuman, openSession, passive } from '@ambionframework/ambion';

const you = defineHuman({ name: 'you', identity: 'The human in the room.' });
const lead = defineAgent({
  name: 'lead',
  identity: 'Answers crisply.',
  instructions: 'Answer the human concisely. Stay quiet when it is not for you.',
  model: 'anthropic/claude-sonnet-4-5',
});

const session = openSession({ name: 'room', participants: [you, lead] });
session.subscribe((e) => e.type === 'say_end' && console.log(`${e.agent}: ${e.message.text}`));
await session.deliver({ from: you, text: 'hello' });
await session.settled();
```

The design contract is [`docs/agent.md`](https://github.com/ambionframework/ambion/blob/main/docs/agent.md);
a hands-on multi-agent room lives in
[`examples/room`](https://github.com/ambionframework/ambion/tree/main/examples/room).

```sh
npm install @ambionframework/ambion
```

Installing needs a token; see the
[repository README](https://github.com/ambionframework/ambion).

Apache 2.0.
