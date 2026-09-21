# @ambionframework/claude

**Run Ambion agents on the Claude Agent SDK.** `claude()` defines the executor
of an agent. `claudeExecution()` gives a runtime or a room the services that
run it. The kernel, `@ambionframework/ambion`, imports no model library. This
package holds the Claude Agent SDK. The
[guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md)
holds every detail. [Ambion](https://ambionframework.com) is a collaboration
kernel for agents and humans.

## When to use it

- **The built-in tools of Claude Code**, such as `Read`, `Grep`, and `Bash`,
  under a policy that the definition states.
- **The Claude Code loop.** The executable owns the loop, and the executor
  feeds it.
- **A session that survives between activations.** `memory: 'seat'` resumes
  one SDK session for the seat.

The executor spawns a process, so the host needs to run one. The Cloudflare
adapter builds its seats on Pi. Use
[`@ambionframework/pi`](https://github.com/ambionframework/ambion/blob/main/docs/pi.md)
for a provider other than Anthropic.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/claude
```

Every package needs Node 26.4 or newer. Until the packages publish to npmjs,
installation needs a GitHub Packages read token; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

**The executor sets no credential.** By default the executable inherits the
environment of the host process, so `ANTHROPIC_API_KEY` reaches it. A value
for `env` replaces that environment.

## Example

```ts
import { defineAgent, defineHuman, defineTool, startRoom } from '@ambionframework/ambion';
import { claude, claudeExecution } from '@ambionframework/claude';
import { Type } from 'typebox';

const owner = defineTool({
  name: 'plan_owner',
  description: 'Name the owner of one plan.',
  parameters: Type.Object({ plan: Type.String() }),
  execute: async ({ plan }) => `${plan}: owned by Dana`,
});

const reviewer = defineAgent({
  name: 'reviewer',
  identity: 'Reads the plan and names what is missing.',
  executor: claude({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'claude-sonnet-5',
    tools: [owner],
    allowedTools: ['Read', 'Grep', 'Bash(git status:*)'],
    canUseTool: async (name, input) =>
      name === 'Bash'
        ? { behavior: 'deny', message: 'Only git status may run.' }
        : { behavior: 'allow', updatedInput: input },
    permissionMode: 'default',
    maxBudgetUsd: 1,
    cwd: '/work/plans',
    memory: 'seat',
  }),
});

const priya = defineHuman({ name: 'priya', identity: 'Owns the delivery.' });

const room = await startRoom({
  name: 'delivery',
  agents: [reviewer],
  execution: claudeExecution({
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    },
  }),
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
}
```

**Pass `execution` to a room or to a runtime.** A room whose seats run on
more than one family passes `composeExecutions({ pi, claude })` from
`@ambionframework/ambion/hosting`. It routes each seat on the `kind` of its
executor.

## Options

| Option                  | Default                           | Meaning                                                      |
| ----------------------- | --------------------------------- | ------------------------------------------------------------ |
| `instructions`          | Required                          | The private guidance of the agent.                           |
| `model`                 | Required                          | A Claude model id.                                           |
| `tools`, `bundles`      | None                              | The tools of the agent and the bundles that add tools.       |
| `speaking`              | `DEFAULT_GUIDANCE`                | The speaking policy. It replaces the default.                |
| `activationTokenLimit`  | The whole record                  | The token limit of the record one activation reads.          |
| `estimateTokens`        | `Math.ceil(text.length / 4)`      | Counts tokens against the limit. It needs the limit.         |
| `memory`                | `'activation'`                    | `'activation'` or `'seat'`.                                  |
| `permissionMode`        | The SDK default, `default`        | The SDK permission mode.                                     |
| `allowedTools`          | None                              | Tools that run with no request. It names the built-in tools. |
| `disallowedTools`       | None                              | Tools the model never sees.                                  |
| `canUseTool`            | Deny every request                | Answers a permission request.                                |
| `maxBudgetUsd`          | None                              | The most one activation may spend, in US dollars.            |
| `effort`                | The SDK default                   | `low`, `medium`, `high`, `xhigh`, or `max`.                  |
| `cwd`                   | The working directory of the host | The working directory of the executable.                     |
| `additionalDirectories` | None                              | Directories that the tools may reach beyond `cwd`.           |

`claudeExecution({ pathToClaudeCodeExecutable, env })` takes two options. The
first selects the executable. The second sets its environment.

## How an activation runs

**One SDK query serves each activation.** The first pass opens the query and
sends the whole view as a user message. A later pass sends the messages that
landed beyond what the model read.

**Freshness rests on the echo.** The SDK sends each user message back. The
activation advances `readThrough` on that echo and on nothing earlier. A line
that lands during a pass joins the streaming input. A line that lands between
passes waits for the next delta.

**Room tools run in process.** One in-process MCP server serves `say`, `seat`,
`unseat`, and the tools of the agent. The model sees them as `mcp__ambion__`
tools. A closing activation receives `say` only.

## Policy and the trust boundary

**The executable runs on the host** with the privileges of the host user.
Its built-in tools run in that process.

**The room defines the seat.** The executor sets three options on every
query. The definition cannot change them.

- `tools` lists the built-in tools that `allowedTools` names. An empty list
  gives the model none.
- `strictMcpConfig` limits the query to the room server.
- `settingSources` is empty, so no `CLAUDE.md` and no settings file reaches
  the model.

**A permission request goes to `canUseTool`.** A room tool and a tool of the
agent get `allow` with no step. Any other request goes to `canUseTool` and
becomes an `approval` step with the answer. The executor denies a request when
`canUseTool` is absent or throws.

**`env` replaces the environment.** The value is not merged with
`process.env`. Pass `PATH`, `HOME`, and the key that the executable needs.

## Memory

**`memory: 'activation'` opens one SDK session for each activation** and
persists nothing. **`memory: 'seat'` persists the session and resumes it in the
next activation.** The release records `{ harness: 'claude', id }`, and the
room hands the id back after a restart. A host that loses the SDK session
store starts a fresh session, and the next release records the new id. Each
resumed activation sends the whole view in its first pass.

## Steps, usage, and failures

**Steps.** The executor records `thinking`, `text`, `tool_call`,
`tool_result`, `approval`, `steer`, and `usage`.

**Usage.** One `usage` step follows each SDK `result`, with the cost that the
SDK reports. `maxBudgetUsd` caps one activation. A spent budget is a permanent
failure.

**Failures.** Credit or authentication text and an `api_error_status` of 400,
401, 402, 403, 404, 405, or 422 are permanent. A length stop is not a failure.
Every other failure is transient.

## Test

`@ambionframework/claude/testing` exports `claudeExecutorHarness`. It runs the
executor suite of `@ambionframework/ambion/conformance` against a fake Claude
Code executable that the SDK spawns through `pathToClaudeCodeExecutable`. The
suite needs no key and no network.

```ts
import { executorConformance } from '@ambionframework/ambion/conformance';
import { claudeExecutorHarness } from '@ambionframework/claude/testing';
import { describe, it } from 'vitest';

// The path of a fake Claude Code executable that the caller supplies.
const executable = new URL('./fake/claude-executable.mjs', import.meta.url).pathname;

for (const memory of ['activation', 'seat'] as const) {
  describe(`claude executor with ${memory} memory`, () => {
    for (const c of executorConformance(claudeExecutorHarness({ executable, memory }))) {
      it(c.name, c.run);
    }
  });
}
```

The published package holds no fake. The repository keeps one at
`packages/claude/test/fake/claude-executable.mjs`. The fake enforces nothing.
It cannot show what the real binary does with `--tools`, the allow list, the
settings sources, or a resume. The package has no live tier.

## Exports

| Export                                                 | Use                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------- |
| `claude(options)`                                      | The executor of an agent definition                        |
| `claudeExecution({ pathToClaudeCodeExecutable, env })` | The `execution` value for `startRoom` and `createRuntime`  |
| `createClaudeExecutor`                                 | The executor of one seat, for a host that composes its own |
| `claudeExecutorHarness`, `scenarioOf`                  | From `/testing`: the suite harness and its scenarios       |

## Troubleshooting

- **`no_execution`.** The room has no `execution`. Pass `claudeExecution()`.
- **The model cannot see `Bash`.** `allowedTools` does not name it.
- **Every request is denied.** `canUseTool` is absent or throws.
- **Abandoned after one attempt with an authentication text.** Check
  `ANTHROPIC_API_KEY`. A custom `env` may have dropped it.
- **`The Claude session ended before the pass did.`** The process exited.
  Check the executable path and `env`.

The [guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md#troubleshooting)
lists more causes.
