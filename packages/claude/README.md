# @ambionframework/claude

**Run Ambion agents on the Claude Agent SDK.** `claude()` defines the executor
of an agent. `claudeExecution()` gives a runtime or a room the services that
run it. The Claude Code executable owns the loop, and the executor feeds it.
[Ambion](https://ambionframework.com) is a collaboration kernel for agents and
humans. The kernel, `@ambionframework/ambion`, imports no model library.

## Install

```sh
npm install @ambionframework/ambion @ambionframework/journal @ambionframework/claude
```

The package needs Node 22.19 or newer and a host that can spawn a process.
Pass `ANTHROPIC_API_KEY`. A Claude subscription works with the token of
`claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN`. The sign-in of
`claude login` cannot reach a seat.

## Example

```ts
import {
  createRuntime,
  defineAgent,
  definePerson,
  defineTool,
  startRoom,
} from '@ambionframework/ambion';
import { claude, claudeExecution } from '@ambionframework/claude';
import { memoryJournals } from '@ambionframework/journal';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';
import { Type } from 'typebox';

const owner = defineTool({
  name: 'plan_owner',
  description: 'Name the owner of one plan.',
  parameters: Type.Object({ plan: Type.String() }),
  execute: async ({ plan }) => `${plan}: owned by Dana`,
});

const drive = openWorkspace({ name: 'delivery', backend: { bash: memoryBackend() } });

const reviewer = defineAgent({
  name: 'reviewer',
  identity: 'Reads the plan and names what is missing.',
  executor: claude({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'claude-sonnet-5',
    tools: [owner],
    bundles: [drive.tools()],
    maxBudgetUsd: 1,
  }),
});

const priya = definePerson({ name: 'priya', identity: 'Owns the delivery.' });

const runtime = createRuntime({ storage: memoryJournals() });
const room = await startRoom({
  runtime,
  name: 'delivery',
  agents: [reviewer],
  execution: claudeExecution({ configRoot: './claude-state' }),
});

try {
  const visit = await room.visit(priya);
  const exchange = await visit.send({ text: 'Does the launch plan have an owner?' });
  for (const message of await exchange.waitForClose()) {
    if (message.kind === 'said') console.log(`${message.from}: ${message.text}`);
  }
  await visit.leave();
} finally {
  await room.stop();
  await drive.dispose();
}
```

Pass `claudeExecution()` as `execution` to a room or runtime.

## Options

`claude(options)` takes the options that every executor shares, and these
three:

- **`model`.** A Claude model id. Required.
- **`maxBudgetUsd`.** The most one activation may spend, in US dollars.
- **`effort`.** `low`, `medium`, `high`, `xhigh`, or `max`.

`claudeExecution({ pathToClaudeCodeExecutable, env, configRoot })` takes three
options. The first selects the executable. The second lays variables over an
allowlist of the host environment. The third names the directory that holds
the config directory of each seat.

A Claude seat has no built-in tool. It reaches files and a shell through the
workspace tools of its bundles. The executable runs as the host user, so a
compromise of it reaches every file that user can read.

## Learn more

The [Claude guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md) holds the trust boundary, the
environment, the config home, the step mapping, and the troubleshooting. The
[executor guide](https://github.com/ambionframework/ambion/blob/main/docs/executors.md) holds the options, the
wiring, the failure classes, and the tests that every executor shares.
`@ambionframework/claude/testing` exports `claudeExecutorFixture`. Use
[`@ambionframework/pi`](https://github.com/ambionframework/ambion/blob/main/docs/pi.md) for a provider other than Anthropic.
