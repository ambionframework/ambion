# @ambionframework/codex

**Run Ambion agents on Codex.** `codex()` defines the executor of an agent.
`codexExecution()` gives a runtime or a room the services that run it. Codex
owns the model loop and its thread, in one `codex app-server` process for each
activation. [Ambion](https://ambionframework.com) is a collaboration kernel
for agents and humans. The kernel, `@ambionframework/ambion`, imports no model
library. This package holds `@openai/codex`.

## Install

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/codex
```

The package needs Node 22.19 or newer, and it brings the `codex` binary. Set
`CODEX_API_KEY`, or run `codex login`. A ChatGPT sign-in runs the seat on a
ChatGPT Plus or Pro subscription: leave `CODEX_API_KEY` out.

## Example

```ts
import { createRuntime, defineAgent, definePerson, startRoom } from '@ambionframework/ambion';
import { codex, codexExecution } from '@ambionframework/codex';
import { memoryJournals } from '@ambionframework/journal';

const planner = defineAgent({
  name: 'planner',
  identity: 'Reads the plan and names what is missing.',
  executor: codex({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'medium',
  }),
});

const priya = definePerson({ name: 'priya', identity: 'Project manager.' });

const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'delivery',
  agents: [planner],
  execution: codexExecution(),
});
const visit = await room.visit(priya);
await visit.send({ text: 'Is the plan ready?' });
```

Pass `codexExecution()` as `execution` to a room or runtime.

## Options

`codex(options)` takes the options that every executor shares, and these
three:

- **`model`.** A Codex model identifier. Required.
- **`modelReasoningEffort`.** How much the model reasons, from `minimal` to
  `persistent`.
- **`reasoningSummary`.** `auto`, `concise`, `detailed`, or `none`. The
  default is `auto`.

`codexExecution({ codexPath, env, home, login })` takes four options: another
binary, an environment overlay, the Codex home of the seats, and the
`auth.json` to link into it. The default home is `~/.ambion/codex`. The
`config.toml` and the `AGENTS.md` of `~/.codex` reach no seat.

A seat has no native tools. Files and a shell come only from the workspace
tools in `bundles`. The pinned `codex` version defines the recipe that
enforces it: run the binary tier and `test/live/exclusive.test.ts` before you
trust a newer version.

## Learn more

The [Codex guide](https://github.com/ambionframework/ambion/blob/main/docs/codex.md) holds the sign-in and the home, the step
mapping, the usage count, the trust boundary, and the troubleshooting. The
[executor guide](https://github.com/ambionframework/ambion/blob/main/docs/executors.md) holds the options, the
wiring, the failure classes, and the tests that every executor shares.
