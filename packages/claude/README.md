# @ambionframework/claude

**Run Ambion agents on the Claude Agent SDK.** `claude()` defines the executor
of an agent. `claudeExecution()` gives a runtime or a room the services that
run it. The kernel, `@ambionframework/ambion`, imports no model library. This
package holds the Claude Agent SDK. The
[guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md)
holds every detail. [Ambion](https://ambionframework.com) is a collaboration
kernel for agents and humans.

## When to use it

- **The Claude Code loop.** The executable owns the loop, and the executor
  feeds it.
- **A seat with no built-in tool.** The seat reaches files and a shell only
  through the workspace tools of its bundles.
- **A session that survives between the activations of one exchange.** The
  seat resumes its SDK session when the room wakes it again.

The executor spawns a process, so the host needs to run one. The Cloudflare
adapter builds its seats on Pi. Use
[`@ambionframework/pi`](https://github.com/ambionframework/ambion/blob/main/docs/pi.md)
for a provider other than Anthropic.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/claude
```

Every package needs Node 22.19 or newer. The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see
[the toolchain guide](https://github.com/ambionframework/ambion/blob/main/docs/toolchain.md#9-release-and-publishing).

**The executor sets no credential.** The executable gets the variables of the
host process that an allowlist names, so `ANTHROPIC_API_KEY` and
`CLAUDE_CODE_OAUTH_TOKEN` reach it. The `env` option adds variables, and
`undefined` removes one.

**A Claude subscription works with a token.** Run `claude setup-token` and
pass the token as `CLAUDE_CODE_OAUTH_TOKEN`. Leave `ANTHROPIC_API_KEY` out,
because a key takes precedence. Each seat has its own Claude config
directory, so the sign-in of `claude login` cannot reach it. The reported
cost is notional. The
[guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md#install-and-sign-in)
holds the limits.

## Example

```ts
import { defineAgent, defineHuman, defineTool, startRoom } from '@ambionframework/ambion';
import { claude, claudeExecution } from '@ambionframework/claude';
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

const priya = defineHuman({ name: 'priya', identity: 'Owns the delivery.' });

const room = await startRoom({
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

**A room with no `execution` runs each Claude seat on the default Claude
execution.** A host that sets `env`, a config root, or a path to the executable passes
`claudeExecution(options)` to a room or to `createRuntime`. A room whose
seats run on more than one family passes a list, such as
`[piExecution(), claudeExecution()]`, or passes none when each family
package is loaded.

## Options

| Option                 | Default            | Meaning                                                       |
| ---------------------- | ------------------ | ------------------------------------------------------------- |
| `instructions`         | Required           | The private guidance of the agent.                            |
| `model`                | Required           | A Claude model id.                                            |
| `tools`, `bundles`     | None               | The tools of the agent and the bundles that add tools.        |
| `speaking`             | `DEFAULT_GUIDANCE` | The speaking policy. It replaces the default.                 |
| `activationTokenLimit` | The whole record   | The token limit of the record one activation reads.           |
| `estimateTokens`       | `'length'`         | The name of the estimator in the runtime. It needs the limit. |
| `maxBudgetUsd`         | None               | The most one activation may spend, in US dollars.             |
| `effort`               | The SDK default    | `low`, `medium`, `high`, `xhigh`, or `max`.                   |

`claudeExecution({ pathToClaudeCodeExecutable, env, configRoot })` takes three
options. The first selects the executable. The second sets its environment.
The third names the directory that holds the config directory of each seat.

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

**A Claude seat has no built-in tool.** It reaches files and a shell only
through the workspace tools of its bundles. They run behind the workspace
port, which can be a remote workstation, so the filesystem of the host is not
the filesystem of the seat. The executable runs on the host as a child process
with the privileges of the host user. Its working directory is a private
scratch directory.

**The room defines the seat.** The executor sets these options on every
query. The definition cannot change them.

- `tools` is empty, so the executable exposes no built-in tool.
- `allowedTools` names the tools of the seat, and the mode is `dontAsk`. The
  executable denies any other call, and it asks no one.
- `strictMcpConfig` limits the query to the room server.
- `settingSources` is empty, so no `CLAUDE.md` and no settings file reaches
  the model.
- `skills` is empty, and the flag tier turns auto-memory off and empties the
  attribution text of commits and pull requests.

**The `env` option adds variables.** The base is an allowlist of the host
variables. A value adds or replaces one, and `undefined` removes one. The
allowlist limits environment variables. It does not limit the filesystem. A
host on Bedrock, Vertex, Foundry, or another provider that `ANTHROPIC_*` does
not cover must pass `env` with the variables it needs.

**Each seat has its own directories.** The executor sets `CLAUDE_CONFIG_DIR`,
`HOME`, and `USERPROFILE` to directories of the seat, after it reads `env`.
Without `configRoot`, they live in the temporary directory, a restart loses
them, and the executor never removes them. The executor also sets
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, and it aliases a built-in name such as
`Bash` to the tool of the seat with the same name.

## Exchange continuity

**Every query persists its SDK session on the local disk.** The release
records `{ harness: 'claude', id }`. The next activation of the seat in the
same exchange resumes that session, and the first activation in a new
exchange starts a fresh one. A host that loses the SDK session store starts
a fresh session, and the next release records the new id. Each resumed
activation sends the whole view in its first pass.

## Steps, usage, and failures

**Steps.** The executor records `thinking`, `text`, `tool_call`,
`tool_result`, `harness`, `steer`, and `usage`.

**Usage.** One `usage` step follows each SDK `result`, with the cost that the
SDK reports. `maxBudgetUsd` caps one activation. A spent budget is a permanent
failure.

**Failures.** Credit, usage-limit, or authentication text and an `api_error_status` of 400,
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
const executable = fileURLToPath(new URL('./fake/claude-executable.mjs', import.meta.url));

describe('claude executor', () => {
  for (const c of executorConformance(claudeExecutorHarness({ executable }))) it(c.name, c.run);
});
```

The published package holds no fake. The repository keeps one at
`packages/claude/test/fake/claude-executable.mjs`. The fake enforces nothing.
It cannot show what the real binary does with `--tools`, the allow list, the
settings sources, or a resume. The live tier in `test/live` runs on the real
binary with `ANTHROPIC_API_KEY`.

## Exports

| Export                                                             | Use                                                       |
| ------------------------------------------------------------------ | --------------------------------------------------------- |
| `claude(options)`                                                  | The executor of an agent definition                       |
| `claudeExecution({ pathToClaudeCodeExecutable, env, configRoot })` | The `execution` value for `startRoom` and `createRuntime` |
| `claudeExecutorHarness`, `scenarioOf`                              | From `/testing`: the suite harness and its scenarios      |

## Troubleshooting

- **`no_execution`.** No loaded package serves the kind of the seat. Import the executor package.
- **The model cannot see `Bash`.** A Claude seat has no built-in tool. Give it a workspace bundle.
- **Abandoned after one attempt with an authentication text.** Check
  `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. The sign-in of
  `claude login` does not reach a seat. A custom `env` may have set the key
  to `undefined`.
- **`The Claude session ended before the pass did.`** The process exited.
  Check the executable path and `env`. The message ends with the last 2,000
  characters of the process stderr.

The [guide](https://github.com/ambionframework/ambion/blob/main/docs/claude.md#troubleshooting)
lists more causes.
