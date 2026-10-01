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
from its environment. By default that is the allowlist of the host
environment, so `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` in
`process.env` reach it; see [Policy and the trust
boundary](#policy-and-the-trust-boundary). A sign-in failure is permanent;
see [Failure classification](#failure-classification).

**A sign-in from `claude login` does not reach a seat.** Each seat runs with
its own [config home](#config-home), and the executable keeps that sign-in
in the config home of the host user. Pass `ANTHROPIC_API_KEY`. A Claude
subscription works with a token: run `claude setup-token` once, and pass the
token as `CLAUDE_CODE_OAUTH_TOKEN`. Remove `ANTHROPIC_API_KEY` from the
environment, because a key takes precedence over the token. To use the
sign-in of the host on Linux, pass an `env` that names `CLAUDE_CONFIG_DIR`,
for example the `~/.claude` directory of the host user. All seats then share
that config home, its sessions, and its `.credentials.json` file.

**On macOS the sign-in lives in the keychain, and the name of its entry
depends on `CLAUDE_CONFIG_DIR`.** When the variable is set, the service name
gets a suffix that the executable derives from the directory. A
`claude login` made without the variable is under the name with no suffix, so
a seat that sets the variable does not read it. On macOS, run `claude login`
with the same `CLAUDE_CONFIG_DIR` set, or use `claude setup-token` and
`CLAUDE_CODE_OAUTH_TOKEN`.

**A custom `env` needs `PATH` and `HOME`.** It needs
`CLAUDE_CODE_OAUTH_TOKEN` when the sign-in came from `claude setup-token`.
The `usage` steps report a notional cost, so `maxBudgetUsd` caps notional
dollars. The subscription has its own usage limit, which is a permanent
failure. A provider may restrict the use of a consumer subscription outside
its own clients. Read its terms first.

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

**A host that sets `env`, a config root, or a path to the executable, passes
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
| `estimateTokens`        | No       | `'length'`                        | The name of the estimator in the runtime that counts tokens. It needs the limit. |
| `permissionMode`        | No       | The SDK default, `default`        | The SDK permission mode. The executor passes it unchanged.                       |
| `allowedTools`          | No       | None                              | Tools that run with no request. It also names the built-in tools the model sees. |
| `disallowedTools`       | No       | None                              | Tools the model never sees.                                                      |
| `canUseTool`            | No       | Deny every request                | Answers a permission request. Each answer becomes an `approval` step.            |
| `maxBudgetUsd`          | No       | None                              | The most one activation may spend, in US dollars.                                |
| `effort`                | No       | The SDK default                   | `low`, `medium`, `high`, `xhigh`, or `max`.                                      |
| `cwd`                   | No       | The working directory of the host | The working directory of the executable.                                         |
| `additionalDirectories` | No       | None                              | Directories that the tools may reach beyond `cwd`.                               |

**`estimateTokens` names an estimator in the runtime.** The room runs it
and windows the record, so the definition carries the name alone. `length`,
the default, counts `Math.ceil(text.length / 4)`. `createRuntime({ estimators })`
registers other names, and a room start fails on a name the runtime does not
hold. [History and limits](room.md#history-and-limits) states the rule.

**`claudeExecution(options)` takes three options.** All are optional.

| Option                       | Default                                  | Meaning                                                                                         |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pathToClaudeCodeExecutable` | The executable of the SDK                | The Claude Code executable to spawn.                                                            |
| `env`                        | The allowlisted variables of the host    | The environment of the executable. A value **replaces** the environment. See the trust section. |
| `configRoot`                 | A private directory in the temporary one | The directory that holds one config directory for each seat. See [Config home](#config-home).   |

The runtime supplies the clock, the call limits, the trace limits, and the
logger.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position and the record window. The Claude executor adds these facts.

**One SDK query serves one activation.** The system prompt is
`pass.mechanism` and `pass.agent`, sent as a plain string. The text of
`pass.record()` opens the streaming input as the first user message. The query keeps
its transcript for the activation. Partial messages are on, so text and
thinking arrive as deltas.

**A pass resolves on the SDK `result`.** The executor pushes the view or the
delta into the streaming input and waits for the `result` message that
answers it. A `result` that arrives while a sent message still waits for its
echo, or while `queued_turn_count` stands above zero, does not end the pass. The pass
waits for the next `result`, and it ends with the earlier one after a grace
period of 5 seconds.

**The SDK echo is the signal that the model read a message.** The SDK
sends each user message back with `isReplay` set. The executor asks the
SDK for that echo with the `replay-user-messages` argument. When the echo
arrives, the executor calls `read` with the range of the message, and it
calls it on nothing earlier. A `tool_result` block in a user message calls
`delivered`. An accepted `say`, a missed `say`, and an accepted `schedule`
also move the position; see
[Executors](executors.md#how-an-activation-runs).

**A steered line moves `readThrough` only when the record before it is
already read.** The core holds the range of an echo that leaves a gap, and
joins it when the gap closes.

**A steer joins the streaming input.** A line that lands during a pass is
pushed into the input as a user message. The executor calls `read` for the
line on its echo. A line that lands before the query starts waits for the
first pass, and the executor sends it after the view. The core records the
`steer` step; see [Executors](executors.md#how-an-activation-runs).

**The cut interrupts the query and ends the pass.** The executor listens
to the signal of the activation. `close` ends the input and the process.

**The room applies the activation token limit.**
[Executors](executors.md#how-an-activation-runs) states the rule. It does
not bound what a resumed session holds.

## How room tools reach the harness

[Executors](executors.md#the-room-tools) states the room tools, the commit
key, and the room answers.

**The executor builds an in-process SDK MCP server named `ambion` for each
activation.** It holds `say`, `schedule`, `seat`, `unseat`, `dismiss`,
`recall`, and the tools of the definition. The model sees them as
`mcp__ambion__say` and so on. Steps and events show the plain name. The
handler of a call takes the id of the call with `callId`, from the
`tool_use` block that the stream named.

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

**The room defines the seat, and fixed options enforce it.** The executor
sets them on every query. The definition cannot change them.

| Option or variable                         | Value                        | Effect                                                                                                  |
| ------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tools`                                    | Base names of the allow list | The built-in tools of the model. An empty allow list gives none.                                        |
| `strictMcpConfig`                          | `true`                       | The query reads no MCP server but the room server.                                                      |
| `settingSources`                           | `[]`                         | The query reads no user, project, or local settings, and no `CLAUDE.md`.                                |
| `skills`                                   | `[]`                         | No skill joins the query. The executor adds no `Skill` entry to the allow list.                         |
| `settings`                                 | `SEAT_SETTINGS`              | The flag tier turns auto-memory off and empties the commit, pull request, and session-link attribution. |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY`          | `1`                          | Auto-memory is off before any settings tier, so a managed setting cannot turn it on.                    |
| `CLAUDE_CONFIG_DIR`                        | The config home of the seat  | The sessions and settings of the seat stay in its own directory.                                        |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1`                          | The executable skips the update check, telemetry, and other traffic that work omits.                    |

A host that passes an `env` with one of these variables keeps its own value.
The flag tier sits below the managed (policy) tier. A managed `attribution`
can still add text to a commit or a pull request. Auto-memory is off through
both the variable and the flag setting. A seat with no built-in tool gets two more settings; see [A seat with no
built-in tool](#a-seat-with-no-built-in-tool).

**What the model sees.** The model sees the room tools, the tools of the
definition, and the built-in tools that `allowedTools` names, minus
`disallowedTools`. A test asserts that an empty policy passes `--tools ''`.

**What the environment holds.** Without `env`, the seat gets the variables
of the host process that an allowlist names, and no other. The allowlist
limits the environment variables of the seat. It does not limit the
filesystem.

**Without `env`, the seat gets a `HOME` of its own.** The executor sets
`HOME` and `USERPROFILE` to the `home` directory of the [seat
directory](#config-home). The host `HOME` does not pass. The shell of the
seat reads no rc file of the host user, such as `.bashrc`. Git, ssh, and
cloud tools read `~` in the seat directory. A `Bash` seat has no git identity
unless the host passes an `env` with the variables it needs. An `env` keeps
its own `HOME`. A seat with `Bash` or `Read` still reaches any absolute path
that the host user can read.

| Kind         | Names                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Exact names  | `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `TZ`, `LANG`, `TERM` |
| Windows      | `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT`              |
| Proxy        | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and the same names in lower case                 |
| Certificates | `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`                                    |
| Credential   | `CLAUDE_CODE_OAUTH_TOKEN`                                                                 |
| Prefixes     | `ANTHROPIC_` and `LC_`                                                                    |

`ENV_ALLOWLIST` and `ENV_PREFIXES` in `src/options.ts` hold the list, and a
test holds them. With `env`, the value **replaces** the environment. The
executor does not merge it with `process.env`, and it applies no
allowlist. A `PATH`, a `HOME`, or a key that the value omits is absent.
Pass the variables that the executable needs, as the example does. In both
cases the executor then removes the variables of a Claude Code session, and
sets `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, and
`CLAUDE_CODE_DISABLE_AUTO_MEMORY` unless the environment holds them.

**A host on Bedrock, Vertex, Foundry, or another provider that `ANTHROPIC_*`
does not cover must pass `env`.** The allowlist holds no `AWS_` and no
`GOOGLE_` prefix, because those names carry broad cloud secrets. Without the
variables of the provider, the executable cannot sign in. Pass an `env` that
holds `PATH`, `HOME`, and the variables that the provider needs.

**A seat starts outside the Claude Code session of its host.** A host that
runs inside Claude Code holds variables such as `CLAUDE_CODE_SESSION_ID`
and `CLAUDE_CODE_REMOTE_SESSION_ID`. With them, every seat reports the id of
the host's session, and a resume opens one transcript for all seats. The
executor removes these variables from the environment, with or without
`env`. It also removes `CLAUDE_CODE_ENTRYPOINT`, and the SDK then sets it
to `sdk-ts`. A test on the fake executable holds the list.

**A seat in a remote Claude Code environment needs its own key.** Without
`CLAUDE_CODE_REMOTE_SESSION_ID`, the executable does not wait for a rotated
host token after a 401. A seat that authenticates with the host's token can
then fail on a long query. Pass `ANTHROPIC_API_KEY` to such a seat.

### A seat with no built-in tool

**A seat whose `allowedTools` names no built-in tool runs in a scratch
directory.** The Workbench seats are of this kind. Such a seat gets the
`work` directory of its [config home](#config-home) as `cwd`. A definition
that sets `cwd` keeps it. A seat that names a built-in tool keeps its `cwd`,
or the working directory of the host.

**The executor routes a built-in name to the tool of the seat with the same
name.** A model can emit `Bash` out of habit, or because a skill text names
it. The executor passes `toolAliases` to the SDK, so that call lands on the
workspace tool and does not fail as unknown. The map holds the four names that the workspace tools of the seat carry:

| Built-in | Tool of the seat |
| -------- | ---------------- |
| `Bash`   | `bash`           |
| `Read`   | `read`           |
| `Write`  | `write`          |
| `Edit`   | `edit`           |

An alias exists only when the seat holds a tool of that name and does not
hold the built-in. A seat with built-in tools gets aliases by the same rule.
**An alias redirects the name and converts no argument.** The model sends the
arguments of the built-in tool, such as `file_path`, and the tool of the seat
validates them against its own schema. A mismatch is a tool error that the
model reads.

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

## Config home

**Each seat has its own Claude config directory.** The executor sets
`CLAUDE_CONFIG_DIR` to `<seat directory>/config` and uses
`<seat directory>/work` as the scratch directory. Without an `env`, it also
makes `<seat directory>/home` for `HOME`. It makes the three with mode
`0700`, on the first need. Every activation of the seat gets the same
directory, because a resume reads the session store there. Two seats get two
directories. The executable keeps its sessions, its settings, and on Linux
its credentials in this directory.

**`configRoot` places the seat directories.** The seat directory is
`<configRoot>/<room>/<seat>`. A relative `configRoot` becomes absolute once,
against the working directory of the host, because the executable reads the
variable as it is. The room name and the seat name become one
path segment each. A prefix and a percent encoding remove every separator
and every dot, so no name leaves the root. Without `configRoot`, each seat
gets a private directory under the temporary directory of the host. Each
seat of each room start leaves one `ambion-claude-*` directory there, and the
executor removes none. A host that wants cleanup passes `configRoot` and owns
that directory. The directory does not survive a restart of the process or the machine. A resume
after the restart then falls back to a fresh session, as designed in
[Exchange continuity](#exchange-continuity). Pass `configRoot` to keep the
sessions of a room across restarts. The executor deletes no session file,
and the host owns the cleanup.

**An `env` that names `CLAUDE_CONFIG_DIR` opts out.** The seat then uses
that directory, as does every seat with the same `env`. This shares the
sessions and, on Linux, the `.credentials.json` file. It does not share the
keychain sign-in of macOS; see [Install and sign in](#install-and-sign-in).

## Exchange continuity

[Executors](executors.md#exchange-continuity) states the rule, the recorded
session, and the fresh start.

**Every query persists its session in the config home of the seat.** The release records
the id that the SDK reports in a `system` message or a `result`. An
activation whose `spec.resume` names a Claude session passes it as
`resume`, with `forkSession` off. The SDK writes one session file for each
activation to its store, and the executor removes none.

**The first pass of a resumed activation sends the whole view.** The Claude
executor sends no delta on resume. The resumed session holds the earlier
record and the view again. `readThrough` starts at zero in each activation,
and a say against newer record gets a `missed` answer. The executor resumes
the session that `pass.resume` names.

**The first message of a resumed query restates the seat's part.** A
resumed session keeps the system prompt it began with, and the SDK ignores
a new `systemPrompt`. The seat's duties and instructions for the
activation, its agent part, therefore go at the head of the first message.
A closing activation resumes the session of the exchange it summarizes.
This message gives it the summary duties and the reader's preferences.
When the resume fails, the fresh session gets the same message, and the
seat's part then appears twice.

**A resume that fails starts a fresh session.** The SDK cannot resume when
the session store is gone, such as after a move to a new disk. The real SDK
sends an init message, then an error result whose text says `No conversation
found with session ID`. A query that ends before any message triggers the
same fallback. The executor clears the id, restarts the query with no
`resume`, and sends the waiting messages again. The restart happens once,
and only for a resumed session. A second failure ends the pass as any
failure does.

## The step mapping

[Executors](executors.md#the-step-vocabulary) holds the eleven step kinds. The
table below gives the SDK source of each step. A message from a subagent
(`parent_tool_use_id` set) adds no step.

| Step          | Source in the SDK                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `thinking`    | `content_block_delta` events, then `content_block_stop`. A block the stream did not send arrives whole.                |
| `text`        | The same events for a text block.                                                                                      |
| `tool_call`   | A `tool_use` block of an assistant message. One step for each id.                                                      |
| `tool_result` | A `tool_result` block of a user message. `is_error` adds `error` with the text of the result.                          |
| `harness`     | The `system` init message of a session. `tools` holds the room tools by plain name. `auth` is the `apiKeySource` name. |
| `approval`    | A permission request for a tool that is not a room tool. `decision` is `allow` or `deny`.                              |
| `steer`       | Never. The core records it. The executor calls `read` on the echo of a steered line.                                   |
| `usage`       | Each `result` message. The step holds what the result adds beyond the earlier total.                                   |

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

**Every failed pass carries the end of the process stderr.** The message
gets the last 2,000 characters of the stderr of the query. This holds for a
failed `result`, for a query that ends early, and for a query that throws. A
failed `result` waits 50 milliseconds, because the stderr arrives on its own
pipe. The wait ends at once when the process ends or `close` runs. The class comes from the result, the status, or the error, and never
from the stderr text.

**The executor reads a status only from `api_error_status`.** Free text
never gives one, because a rate limit names a token count that reads like a
status.

**The shared classifier reads the text of a failed result.** The
[text set](executors.md#failure-classification) holds the words of the
Claude Code login.

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

**The package has a live tier.** `packages/claude/test/live/` holds six
files, each with one claim that the fake cannot prove: approvals, tool
exclusivity, memory across activations, a mixed room, steering, and the
trace. `vitest.live.config.ts` runs them on the real Claude binary with
`ANTHROPIC_API_KEY`, and the block skips without it. A run costs money. The
live tests of the Workbench also run the `design` seat. They ask each seat
for its tool list and for `/etc/hosts`. See [Example](example.md).

## Troubleshooting

| Symptom                                                                  | Cause                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each seat fails at once with `no_execution`                              | No loaded package serves the kind of the seat. Import the executor package, or pass `claudeExecution()`.                                                                           |
| `Cannot run an executor of kind 'pi': this seat needs 'claude'.`         | A Pi seat reached a Claude executor through an execution with no kind. Pass the execution of each family.                                                                          |
| The model cannot see `Bash` or `Read`                                    | `allowedTools` does not name it. The list gives the built-in tools, and an empty list gives none.                                                                                  |
| Every request is denied                                                  | `canUseTool` is absent, or it throws. The executor denies both. Read the `approval` steps.                                                                                         |
| The model ignores `CLAUDE.md` and project settings                       | `settingSources` is empty by design. Put the guidance in `instructions`.                                                                                                           |
| A project MCP server is missing                                          | `strictMcpConfig` is on. The query reads the room server only.                                                                                                                     |
| The seat is abandoned after one attempt with an authentication text      | A permanent failure. Pass `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. A seat does not read the sign-in of `claude login`. A custom `env` may have dropped the key or `HOME`. |
| `The Claude session ended before the pass did.`                          | The process exited. Check `pathToClaudeCodeExecutable` and `env`. The message ends with the last 2,000 characters of the process stderr. The text never changes the failure class. |
| A failed pass names a model or a setting the executable does not know    | The message ends with the stderr of the process, which often names the cause. For an unknown model, it says that the model catalog does not describe it.                           |
| A `Bash` seat has no git identity, or `~` holds nothing of the host user | Without `env`, `HOME` is the `home` directory of the seat. Pass an `env` with `HOME` and the other variables the seat needs.                                                       |
| The executable cannot sign in on Bedrock, Vertex, or Foundry             | The allowlist holds no variable of that provider. Pass an `env` with `PATH`, `HOME`, and the variables the provider needs.                                                         |
| The executable cannot find `node`, `git`, or `HOME`                      | A custom `env` replaced the environment. Add `PATH` and `HOME`.                                                                                                                    |
| A pass ends 5 seconds after its result                                   | A sent message had no echo yet. The grace period ended the pass.                                                                                                                   |
| The seat is abandoned with a budget text                                 | `maxBudgetUsd` ran out. The failure is permanent. Raise the budget.                                                                                                                |
| A resumed seat opens a new session                                       | The SDK could not resume the recorded id. The fallback is designed, and the release records the new id.                                                                            |
| A say returns `Not delivered — the room moved`                           | The freshness rule refused a say against newer record. The model reads the new messages and decides again.                                                                         |
