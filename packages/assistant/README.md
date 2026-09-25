# @ambionframework/assistant

`@ambionframework/assistant` supplies a reusable ordinary agent definition for
rooms that need help seating and unseating specialists and writing closing
summaries.

Install it alongside the core package using the repository's GitHub Packages
registry configuration:

```sh
npm install @ambionframework/ambion @ambionframework/assistant
```

```ts
import { startRoom } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';

const assistant = defineAssistant({
  model: 'anthropic/claude-sonnet-5',
  instructions: 'Prefer small, reversible changes.',
  bundles: [workspace.tools()],
});

await startRoom({
  name: 'delivery',
  goal: 'Implement the agreed milestone.',
  assistant,
  agents: [builder, reviewer],
  seats: { builder: 'named', reviewer: 'named' },
});
```

The room expands the shorthand into the ordinary definitions before it validates
or composes the room. The assistant joins with `broadcast` attention and writes
the optional closing summary. It has no kernel authority beyond its ordinary
room tools.

Application instructions follow the maintained defaults and take precedence
when they conflict. The room still enforces membership, activation authority,
freshness, recipients, exchange closure, and summary provenance.

Omitting `seats` starts all defined agents at broadcast attention. Use
`seats: {}` to start with only the assistant. Supply the assistant definition
again in the complete `agents` definitions when calling `resumeRoom`.

The default assistant is passive when the specialists are seated at
broadcast or presence attention. It speaks during an exchange only when a
person or a specialist addresses it, or when an idle specialist at named
attention needs one
directed request. The closing summary reports corrections, conflicts, and
questions for the person. Behavioral
defaults are model instructions; the kernel enforces collaboration authority.

Explicit user constraints apply across seating and specialist handoffs,
including scope, output limits, and permissions such as “do not edit files.”
Role instructions are defaults and yield to those constraints. A constraint
stays in force until the person withdraws it. Conflicting reports stay
qualified in summaries. Human revision feedback is sent as one concise directed request to
the responsible specialist. Assignment deduplication is scoped to the current
exchange, so an explicit later request to recheck or revise activates the
specialist once even when an earlier result remains in the record.

See the [assistant contract](https://github.com/ambionframework/ambion/blob/main/docs/assistant.md)
for configuration, behavior, and evaluation commands.
