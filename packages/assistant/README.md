# @ambionframework/assistant

**This package supplies a reusable assistant agent for rooms.** The assistant
seats and unseats specialists, routes each request, and writes the closing
summary. It is an ordinary agent definition with maintained instructions and
no kernel authority beyond its room tools.

## Install

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/assistant @ambionframework/pi
```

## Use

`defineAssistant` requires an `executor` function. The function receives the
parts of the assistant (`instructions`, `tools`, and `bundles`) and returns an
executor of any package. Install the package of the executor that you pick.
Your own `instructions` follow the defaults and take precedence when they
conflict.

```ts
import { createRuntime, startRoom } from '@ambionframework/ambion';
import { defineAssistant } from '@ambionframework/assistant';
import { memoryJournals } from '@ambionframework/journal';
import { pi, piExecution } from '@ambionframework/pi';

const assistant = defineAssistant({
  instructions: 'Prefer small, reversible changes.',
  bundles: [workspace.tools()],
  executor: (parts) => pi({ ...parts, model: 'anthropic/claude-sonnet-5', thinking: 'low' }),
});

const runtime = createRuntime({ storage: memoryJournals() });
await startRoom({
  runtime,
  name: 'delivery',
  goal: 'Implement the agreed milestone.',
  assistant,
  agents: [builder, reviewer],
  seats: { builder: 'named', reviewer: 'named' },
  execution: piExecution(),
});
```

The `assistant` option registers the definition, seats it at `broadcast`, and
makes it the summary writer. Pass `seats: {}` to start with only the
assistant. Supply the assistant again in `agents` when you call `resumeRoom`.
To run the assistant on Codex, return `codex({ ...parts, model })` from the
function and add `codexExecution()` to `execution`.

The room enforces seating, activation authority, freshness, recipients, and
summary provenance. The behavioral defaults are model instructions.

See the [assistant contract](https://github.com/ambionframework/ambion/blob/main/docs/assistant.md)
for the behavior, the overrides, and the evaluation commands.
