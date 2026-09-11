# @ambionframework/ambion

Build applications as independently owned agents collaborating behind one
human-facing assistant. Domain agents wait in a named room and work through
one ordered record; each keeps its own model, tools and workspace, and decides
whether it has anything to add. The assistant selects specialists from the
room's reserve and consolidates multi-agent work when needed, without gaining
general-purpose authority over the application.

The root import is deliberately the small application surface. `defineAgent`
makes an agent, `defineHuman` names a person, `defineTool` gives agents hands,
and `defineWorkspace` names the identity and data boundary those hands reach
into. `startSession` brings up the room, `visitSession` puts somebody in it,
`readSession` reads it without starting anything, and `stopSession` takes it
down.

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

const session = startSession({
  name: 'room',
  goal: 'Answer what the person brings, and nothing else.',
  assistant,
  agents: [lead],
});
session.subscribe((e) => e.type === 'message' && console.log(`${e.message.from} spoke`));

const visit = await visitSession(session, you);
await visit.deliver({ text: 'hello' });
await session.quiet();

await stopSession(session);
```

Hosts that replace time, persistence, model sessions, transport, or workspace
storage import those integration points from `@ambionframework/ambion/host`.
Transport authors can import the advanced, JSON-safe seat protocol from
`@ambionframework/ambion/protocol`. Neither subpath is needed to define and run
an application with the defaults.

The design contract is [`docs/agent.md`](https://github.com/ambionframework/ambion/blob/main/docs/agent.md),
with presence — who is in a session, and what the agents do about it — in
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
