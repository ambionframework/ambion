# @ambionframework/assistant

`@ambionframework/assistant` supplies a reusable ordinary agent definition for
rooms that need help selecting specialists, steering rare divergences, and
writing closing summaries.

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

The default assistant uses corrective steering extremely rarely, when the
record shows divergence or context rot. It avoids repeated assignments and
reserves consolidation for the separate closing activation. Behavioral
defaults are model instructions; the kernel enforces collaboration authority.

Explicit user constraints apply across seating and specialist handoffs,
including scope, output limits, and permissions such as “do not edit files.”
Role instructions are defaults and yield to those constraints. Specialist
claims about missing artifacts should be checked against known paths before
they are repeated; conflicting reports stay qualified in artifacts and
summaries. Human revision feedback is sent as one concise directed request to
the responsible specialist. Assignment deduplication is scoped to the current
exchange, so an explicit later request to recheck or revise activates the
specialist once even when an earlier result remains in the record.

See the [assistant contract](https://github.com/ambionframework/ambion/blob/main/docs/assistant.md)
for configuration, behavior, and evaluation commands.
