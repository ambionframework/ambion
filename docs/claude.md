# The Claude executor

`@ambionframework/claude` runs Ambion agents on the Claude Agent SDK. This
page holds what is specific to the Claude adapter. [Executors](executors.md)
holds the shared contract: the activation flow, the room tools, exchange
continuity, failure classification, the step vocabulary, and the trace. [The
Pi guide](pi.md) covers a second shipped family, and [the
Codex guide](codex.md) a third. [The
README](../README.md) holds the positioning.

## What it is and when to use it

**The Claude Code executable owns the loop. The executor feeds it.**
`claude()` defines the executor of one agent. `claudeExecution()` gives a
room or a runtime the services that run it. The SDK spawns the executable as
a child process of the host. The executor pushes user messages into the
process and reads its messages back.

Use the Claude executor when the agent needs:

- **The built-in tools of Claude Code**, such as `Read`, `Grep`, `Edit`, and
  `Bash`, under a policy that the definition states.
- **The agent loop of Claude Code**, with its own context handling, on a
  Claude model.
- **A session that survives between the activations of one exchange.** The
  seat resumes its SDK session when the room wakes it again.
- **Steering during a pass.** A line that lands mid-activation joins the
  streaming input.

The executor needs a host that can spawn a process. The Cloudflare adapter
builds its seats on Pi and does not run this executor. Use
[the Pi executor](pi.md) for a provider other than Anthropic.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/claude
```

Every package needs Node 22.19 or newer. The packages install from npmjs with no token. A dev build of `main` installs
from GitHub Packages; see
[Toolchain](toolchain.md#9-release-and-publishing). The package depends on
`@anthropic-ai/claude-agent-sdk` at an exact version.

**The executor sets no credential.** The executable reads its credentials
from its environment. By default that is the environment of the host
process, so `ANTHROPIC_API_KEY` in `process.env` reaches it. A sign-in
failure is permanent; see [Failure classification](#failure-classification).

**`pathToClaudeCodeExecutable` selects the binary.** Without it, the SDK
finds the executable that it ships with.

## A complete example

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

**A host that sets `env`, or a path to the executable, passes
`claudeExecution(options)` to a room or to `createRuntime`.**
[Executors](executors.md#the-executor-contract) states how a room resolves
an execution.

## Options

**`claude(options)` returns a frozen executor of kind `claude`.** The kernel
validates the shared fields. The executor passes each policy field to the SDK
unchanged.

| Option                  | Required | Default                           | Meaning                                                                          |
| ----------------------- | -------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `instructions`          | Yes      | None                              | The private guidance of the agent.                                               |
| `model`                 | Yes      | None                              | A Claude model id. The executor passes it as `--model`.                          |
| `tools`                 | No       | None                              | The tools of the agent, from `defineTool`. They run in the host process.         |
| `bundles`               | No       | None                              | Tool bundles. Their guidance joins the prompt after the speaking policy.         |
| `speaking`              | No       | `DEFAULT_GUIDANCE`                | The speaking policy. It replaces the default.                                    |
| `activationTokenLimit`  | No       | The whole record                  | The token limit of the record one activation reads. A positive integer.          |
| `estimateTokens`        | No       | `Math.ceil(text.length / 4)`      | Counts tokens against the limit. It needs `activationTokenLimit`.                |
| `permissionMode`        | No       | The SDK default, `default`        | The SDK permission mode. The executor passes it unchanged.                       |
| `allowedTools`          | No       | None                              | Tools that run with no request. It also names the built-in tools the model sees. |
| `disallowedTools`       | No       | None                              | Tools the model never sees.                                                      |
| `canUseTool`            | No       | Deny every request                | Answers a permission request. Each answer becomes an `approval` step.            |
| `maxBudgetUsd`          | No       | None                              | The most one activation may spend, in US dollars.                                |
| `effort`                | No       | The SDK default                   | `low`, `medium`, `high`, `xhigh`, or `max`.                                      |
| `cwd`                   | No       | The working directory of the host | The working directory of the executable.                                         |
| `additionalDirectories` | No       | None                              | Directories that the tools may reach beyond `cwd`.                               |

**`claudeExecution(options)` takes two options.** Both are optional.

| Option                       | Default                             | Meaning                                                                                         |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pathToClaudeCodeExecutable` | The executable of the SDK           | The Claude Code executable to spawn.                                                            |
| `env`                        | The environment of the host process | The environment of the executable. A value **replaces** the environment. See the trust section. |

The runtime supplies the clock, the call limits, the logger, and the
transport. The Claude execution does not read `limits.trace` from the host.
It applies the default trace limits, 65,536 bytes of tool output and 1,000
steps for each pass. `createClaudeExecutor` builds one executor for a seat,
and its `query` option replaces the SDK entry.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position and the record window. The Claude executor adds these facts.

**One SDK query serves one activation.** The system prompt is `mechanism`
and `agent` from `renderActivation`, sent as a plain string. The `context`
part opens the streaming input as the first user message. The query keeps
its transcript for the activation. Partial messages are on, so text and
thinking arrive as deltas.

**A pass resolves on the SDK `result`.** The executor pushes the view or the
delta into the streaming input and waits for the `result` message that
answers it. A `result` that arrives while a sent message still waits for its
echo, or while `queued_turn_count` stands above zero, does not end the pass. The pass
waits for the next `result`, and it ends with the earlier one after a grace
period of 5 seconds.

**`readThrough` advances on the SDK echo.** The SDK sends each user message
back with `isReplay` set. The executor asks the SDK for that echo with the
`replay-user-messages` argument. `readThrough` moves to the position of the
message when its echo arrives, and on nothing earlier. An accepted `say`
and a missed `say` also move the position; see
[Executors](executors.md#how-an-activation-runs).

**A steered line moves `readThrough` only when the record before it is
already read.** An echo that leaves a gap does not advance the position.

**A steer joins the streaming input.** A line that lands during a pass is
pushed into the input as a user message. The trace records `steer` with
`consumed: true` on its echo. A line that lands before the query starts waits
for the first pass. The executor sends it after the view unless the view
already holds it.

**`abort` interrupts the query and ends the pass.** `close` ends the input
and the process.

**The activation token limit windows the record.**
[Executors](executors.md#how-an-activation-runs) states the rule. It does
not bound what a resumed session holds.

## How room tools reach the harness

[Executors](executors.md#the-room-tools) states the three tools, the commit
key, and the room answers.

**The executor builds an in-process SDK MCP server named `ambion` for each
activation.** It holds `say`, `seat`, `unseat`, and the tools of the
definition. The model sees them as `mcp__ambion__say` and so on. Steps and
events show the plain name.

- The executable calls them over the SDK transport. The tool code never
  runs in the child process.
- **The SDK builds each MCP tool from a Zod shape.** The executor reads the
  TypeBox schema of a tool as JSON Schema and converts each property.
- **A refusal or a thrown error becomes a tool result with `isError`.** The
  text is the room's refusal message or the error the tool threw.

The approver answers for these tools. A request for a room tool gets `allow`
with no `approval` step. The same holds for the tools of the definition,
because the definition grants them.

## Tools and bundles an agent can add

[Definitions and tools](agent.md#tools) states `AmbionTool`, `defineTool`,
and how a bundle adds tools and guidance. The Claude executor adds these
facts.

**A tool context carries `agent`, `signal`, `callId`, `room`, `activation`,
and `exchange`.** `prepareArguments` runs before the tool. A string result
becomes text content. The executor does not pass `onUpdate`. The `signal`
aborts when the activation is cut.

**The built-in tools come from the policy.** The model sees a built-in tool
only when `allowedTools` names it. `Bash(git status:*)` names `Bash`. Only
the definition can add or remove one. See the next section.

## Policy and the trust boundary

**The Claude Code executable runs on the host.** It is a child process with
the privileges of the host user. Its built-in tools run in that process, in
`cwd` and in `additionalDirectories`. `Bash` gives the model a shell. The room
tools and the tools of the definition run in the host process.

**The room defines the seat, and three fixed options enforce it.** The
executor sets them on every query. The definition cannot change them.

| Option            | Value                        | Effect                                                                   |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `tools`           | Base names of the allow list | The built-in tools of the model. An empty allow list gives none.         |
| `strictMcpConfig` | `true`                       | The query reads no MCP server but the room server.                       |
| `settingSources`  | `[]`                         | The query reads no user, project, or local settings, and no `CLAUDE.md`. |

**What the model sees.** The model sees the room tools, the tools of the
definition, and the built-in tools that `allowedTools` names, minus
`disallowedTools`. A test asserts that an empty policy passes `--tools ''`.

**What the environment holds.** Without `env`, the executable inherits the
whole environment of the host, and `Bash` can print it. With `env`, the value
**replaces** the environment. The executor does not merge it with
`process.env`. A `PATH`, a `HOME`, or a key that the value omits is absent.
Pass the variables that the executable needs, as the example does. A seat
that runs `Bash` should get no more than that.

**A permission request goes to `canUseTool`.** A tool call that the allow
list does not cover asks. The executor answers it in this order:

1. A room tool or a tool of the definition gets `allow`.
2. Any other request goes to `canUseTool`.
3. The executor denies a request when `canUseTool` is absent, returns
   nothing, or throws.

Each answer except the first becomes an `approval` step with the call id, the
tool name, and the decision. The default `permissionMode` is the SDK default.
With `dontAsk`, the executor adds the room tool names to the allow list,
because the SDK denies what it does not list. The executor never sets
`allowDangerouslySkipPermissions`, and the SDK types say `bypassPermissions`
needs it. The tests check `acceptEdits` only.

**`maxBudgetUsd` caps one activation.** The SDK enforces it for the query.
A spent budget is a permanent failure.

## Exchange continuity

[Executors](executors.md#exchange-continuity) states the rule, the recorded
session, and the fresh start.

**Every query persists its session on the local disk.** The release records
the id that the SDK reports in a `system` message or a `result`. An
activation whose `spec.resume` names a Claude session passes it as
`resume`, with `forkSession` off. The SDK writes one session file for each
activation to its store, and the executor removes none.

**The first pass of a resumed activation sends the whole view.** The Claude
executor sends no delta on resume. The resumed session holds the earlier
record and the view again. `readThrough` starts at zero in each activation,
and a say against newer record gets a `missed` answer.

**A resume that fails starts a fresh session.** The SDK cannot resume when
the session store is gone, such as after a move to a new disk. The real SDK
sends an init message, then an error result whose text says `No conversation
found with session ID`. A query that ends before any message triggers the
same fallback. The executor clears the id, restarts the query with no
`resume`, and sends the waiting messages again. The restart happens once,
and only for a resumed session. A second failure ends the pass as any
failure does.

## The step mapping

[Executors](executors.md#the-step-vocabulary) holds the ten step kinds. The
table below gives the SDK source of each step. A message from a subagent
(`parent_tool_use_id` set) adds no step.

| Step          | Source in the SDK                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `thinking`    | `content_block_delta` events, then `content_block_stop`. A block the stream did not send arrives whole. |
| `text`        | The same events for a text block.                                                                       |
| `tool_call`   | A `tool_use` block of an assistant message. One step for each id.                                       |
| `tool_result` | A `tool_result` block of a user message. `is_error` adds `error` with the text of the result.           |
| `approval`    | A permission request for a tool that is not a room tool. `decision` is `allow` or `deny`.               |
| `steer`       | The echo of a steered line is `consumed: true`. A line between passes is `consumed: false`.             |
| `usage`       | Each `result` message. The step holds what the result adds beyond the earlier total.                    |

## Usage and cost

**One `usage` step follows each SDK `result`.** The executor sums
`modelUsage` over every model of the result for `input`, `output`,
`cacheRead`, and `cacheWrite`. `cost` is `total_cost_usd`. The SDK reports
running totals for the query. The executor writes the difference from the
earlier result, and writes no step when both tokens and cost stand at zero.

The known limits:

- **A step covers one SDK result.** The step of a pass with several
  results sums them.
- **`cost` is the number that the SDK reports.** The executor does not
  compute it.
- **A resumed session may report totals of earlier activations.** The first
  result of an activation counts the whole total it carries. The tests do
  not cover what a real resumed session reports.

## Failure classification

[Executors](executors.md#failure-classification) states the shared rule.
**The table below holds the Claude SDK results this executor classifies.**

| Result                                                | Outcome                                        |
| ----------------------------------------------------- | ---------------------------------------------- |
| `error_max_budget_usd`                                | `permanent`                                    |
| `error_max_turns`, or a `stop_reason` of `max_tokens` | No failure. The pass reports `stop: 'length'`. |

**The executor reads a status only from `api_error_status`.** Free text
never gives one, because a rate limit names a token count that reads like a
status.

**A failed result whose text matches one of these patterns is permanent.**
`credit balance`, `authentication_error`, `permission_error`,
`invalid_request_error`, an invalid API key, `x-api-key`, `unauthorized`,
`permission denied`, and `not logged in`.

## Testing

**A fake Claude Code executable tests the executor with no key.**
`@ambionframework/claude/testing` exports `claudeExecutorHarness` and
`scenarioOf`. The harness runs the executor suite of
`@ambionframework/ambion/conformance` through the real driver. The SDK
spawns `test/fake/claude-executable.mjs` through
`pathToClaudeCodeExecutable`. The fake reads a scenario from `AMBION_FAKE`,
a JSON object whose `turns` field holds one list of actions for each user
message, and speaks the
stream-json protocol of the SDK over stdio.

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

**The fake ships in the repository only.** The package publishes `dist`,
and `dist` holds no fake. The repository keeps its fake at
`packages/claude/test/fake/claude-executable.mjs`. A caller who wants the
same run writes a fake with the protocol above. The test
`packages/claude/test/mixed-room.test.ts` also runs a Pi seat beside a
Claude seat on a fake.

**What the fake proves.** It proves the arguments the SDK passes to the
executable, and the initialize request. It proves the echo and steer path,
exchange continuity and the resume fallback, the approval steps, the step mapping, the
usage arithmetic, and the failure classes.

**What it cannot prove.** The fake does not enforce anything. It cannot show
that the real binary honors `--tools`, `--allowedTools`,
`--disallowedTools`, `--strict-mcp-config`, or an empty setting source. It
cannot show which requests the real permission engine sends to `canUseTool`.
It cannot show real token counts, real cost, the real `result` shape, the
behavior of a real session store on resume, or a real sign-in. It never runs
a model.

**The package has no live tier of its own.** The live tests of the
Workbench run the `design` seat on the real Claude binary. They ask each seat
for its tool list and for `/etc/hosts`. See [Example](example.md).

## Troubleshooting

| Symptom                                                             | Cause                                                                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Each seat fails at once with `no_execution`                         | No loaded package serves the kind of the seat. Import the executor package, or pass `claudeExecution()`.                   |
| `Cannot run an executor of kind 'pi': this seat needs 'claude'.`    | A Pi seat ran under `claudeExecution()`. Route with `composeExecutions`.                                                   |
| The model cannot see `Bash` or `Read`                               | `allowedTools` does not name it. The list gives the built-in tools, and an empty list gives none.                          |
| Every request is denied                                             | `canUseTool` is absent, or it throws. The executor denies both. Read the `approval` steps.                                 |
| The model ignores `CLAUDE.md` and project settings                  | `settingSources` is empty by design. Put the guidance in `instructions`.                                                   |
| A project MCP server is missing                                     | `strictMcpConfig` is on. The query reads the room server only.                                                             |
| The seat is abandoned after one attempt with an authentication text | A permanent failure. Check `ANTHROPIC_API_KEY`. A custom `env` may have dropped it.                                        |
| `The Claude session ended before the pass did.`                     | The process exited. Check `pathToClaudeCodeExecutable` and `env`. The executor does not forward the stderr of the process. |
| The executable cannot find `node`, `git`, or `HOME`                 | A custom `env` replaced the environment. Add `PATH` and `HOME`.                                                            |
| A pass ends 5 seconds after its result                              | A sent message had no echo yet. The grace period ended the pass.                                                           |
| The seat is abandoned with a budget text                            | `maxBudgetUsd` ran out. The failure is permanent. Raise the budget.                                                        |
| A resumed seat opens a new session                                  | The SDK could not resume the recorded id. The fallback is designed, and the release records the new id.                    |
| A say returns `Not delivered — the room moved`                      | The freshness rule refused a say against newer record. The model reads the new messages and decides again.                 |
