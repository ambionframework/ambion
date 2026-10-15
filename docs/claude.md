# The Claude executor

`@ambionframework/claude` runs Ambion agents on the Claude Agent SDK. [Use an
executor](executors.md#use-an-executor) holds the install, the shared
options, the wiring, the sign-in rules, and the shared troubleshooting. This
page holds what differs for Claude. [The README](../README.md) holds the
positioning.

## What it is

**The Claude Code executable owns the loop. The executor feeds it.**
`claude()` defines the executor of one agent. `claudeExecution()` gives a
room or a runtime the services that run it. The SDK spawns the executable as
a child process of the host. The executor pushes user messages into the
process and reads its messages back.

**Claude fits the agent loop of Claude Code on a Claude model.**

- **A session that survives between the activations of one exchange.** The
  seat resumes its SDK session when the room wakes it again.
- **Steering during a pass.** A line that lands mid-activation joins the
  streaming input.

The executor needs a host that can spawn a process. The Cloudflare adapter
builds its seats on Pi and does not run this executor. Use
[the Pi executor](pi.md) for a provider other than Anthropic.

## Sign in

**The package depends on `@anthropic-ai/claude-agent-sdk` at an exact
version.** The executor sets no credential. The executable reads its
credentials from its environment. The seat gets the allowlisted variables of
the host process. `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` reach it;
see [What the environment holds](#what-the-environment-holds).

**The sign-in of `claude login` cannot reach a seat.** Each seat runs with
its own [config home](#config-home). The executor sets `CLAUDE_CONFIG_DIR`
and `HOME` after it reads `env`, so no option changes them. On macOS the
keychain entry depends on `CLAUDE_CONFIG_DIR`, so a seat cannot read it.
Pass `ANTHROPIC_API_KEY`. A Claude subscription works with a token. Run
`claude setup-token` once, and pass the token as `CLAUDE_CODE_OAUTH_TOKEN`.
Remove `ANTHROPIC_API_KEY` from the environment, because a key takes
precedence over the token.

**Another provider needs `env`.** [Options](#options) describes it.

## A complete example

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

## Options

**`claude(options)` takes the [shared options](executors.md#options-every-executor-takes)
and three of its own.** The executor passes `maxBudgetUsd` and `effort` to
the SDK unchanged. The definition has no field for a tool, a directory, or a
permission, because a Claude seat has no built-in tool.

| Option         | Required | Default         | Meaning                                                 |
| -------------- | -------- | --------------- | ------------------------------------------------------- |
| `model`        | Yes      | None            | A Claude model id. The executor passes it as `--model`. |
| `maxBudgetUsd` | No       | None            | The most one activation may spend, in US dollars.       |
| `effort`       | No       | The SDK default | `low`, `medium`, `high`, `xhigh`, or `max`.             |

**`maxBudgetUsd` caps one activation.** The SDK enforces it for the query. A
spent budget is a permanent failure.

**`claudeExecution(options)` takes three options.** All are optional.

| Option                       | Default                                  | Meaning                                                                                                         |
| ---------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pathToClaudeCodeExecutable` | The executable of the SDK                | The Claude Code executable to spawn.                                                                            |
| `env`                        | None                                     | Variables to lay over the allowlisted environment, such as those of Bedrock or Vertex. `undefined` removes one. |
| `configRoot`                 | A private directory in the temporary one | The directory that holds one config directory for each seat. See [Config home](#config-home).                   |

## How an activation runs

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
period of 5 seconds. An echo that arrives in that period cancels it. A line
that lands during the final answer runs as a turn of its own, and its echo
comes with that turn. The pass then ends with the `result` of that turn. A
failed `result` keeps its grace period.

**The SDK echo is the signal that the model read a message.** The SDK
sends each user message back with `isReplay` set. The executor asks the
SDK for that echo with the `replay-user-messages` argument. When the echo
arrives, the executor calls `read` with the range of the message, and it
calls it on nothing earlier. A `tool_result` block in a user message calls
`delivered`. The core holds the range of an echo that leaves a gap, and
joins it when the gap closes.

**A steer joins the streaming input.** A line that lands during a pass is
pushed into the input as a user message. The executor calls `read` for the
line on its echo. A line that lands before the query starts waits for the
first pass, and the executor sends it after the view.

**The cut interrupts the query and ends the pass.** The executor listens
to the signal of the activation. `close` ends the input and the process.

**The token limit bounds the view alone.** It does not bound what a resumed
session holds.

## How room tools reach the harness

**The executor builds an in-process SDK MCP server named `ambion` for each
activation.** It holds `say`, `schedule`, `seat`, `unseat`, `dismiss`,
`recall`, and the tools of the definition. The model sees them as
`mcp__ambion__say` and so on. Steps and events show the plain name. The
handler of a call takes the id of the call with `callId`, from the
`tool_use` block that the stream named. The server omits `seat` when the
reserve held no agent as the room composed, and omits `seat` and `unseat`
when the host turned seating off.

- The executable calls them over the SDK transport. The tool code never
  runs in the child process.
- **The SDK builds each MCP tool from a Zod shape.** The executor reads the
  TypeBox schema of a tool as JSON Schema and converts each property.
- **A refusal or a thrown error becomes a tool result with `isError`.** The
  text is the room's refusal message or the error the tool threw.

The allow list of the query names these tools, and the mode `dontAsk` denies
every other call. The executor has no permission callback, so no call waits
for an answer.

## Tools and bundles an agent can add

**A tool context carries `agent`, `signal`, `callId`, `room`, `activation`,
and `exchange`.** `prepareArguments` runs before the tool. A string result
becomes text content. The executor does not pass `onUpdate`. The `signal`
aborts when the activation is cut. `pass.tools` holds the tools of the
definition and of its bundles. The workspace bundle gives `read`, `write`,
`edit`, `apply_patch`, and `bash`. [Definitions and tools](agent.md#tools)
states the rest.

## Policy and the trust boundary

**A Claude seat has no built-in tool.** The model sees no `Bash`, `Read`,
`Edit`, or `Grep` of Claude Code. It reaches files and a shell only through
the workspace tools, behind the workspace port. The seat reaches the
filesystem that the workspace backend serves: `memoryBackend` serves memory,
`directoryBackend` serves one directory of the host, and a workstation serves
a remote server. The `session` step lists the tools of the seat.

**The Claude Code process runs on the host as the host user.** Its working
directory is a private scratch directory, and its environment is the
environment of the seat. A compromise of that process reaches every file the
host user can read, the credential in its environment, and the network. The
seat itself has no tool for these. The room tools and the tools of the
definition run in the host process.

**The room defines the seat, and fixed options enforce it.** The executor
sets them on every query. The definition cannot change them.
`src/options.ts` holds the values.

- **`tools: []`.** The executable exposes no built-in tool.
- **`allowedTools` and `permissionMode: 'dontAsk'`.** The allow list names the
  room tools, the tools of the definition, and the workspace tools, as
  `mcp__ambion__<name>`. The executable denies any other call and asks no one.
- **`cwd`.** The scratch directory `<seat directory>/work`.
- **`strictMcpConfig: true`.** The query reads no MCP server but the room
  server.
- **`settingSources: []`.** The query reads no user, project, or local
  settings, and no `CLAUDE.md`.
- **`skills: []`.** No skill joins the query.
- **`verbatimPrompts: true`.** The executable delivers each user message as
  written. It reads no `@path` file and runs no `/` command.
- **`settings`.** The flag tier turns auto-memory off and empties the commit,
  pull request, and session-link attribution.
- **`toolAliases`.** See [Tool aliases](#tool-aliases).
- **Variables.** `CLAUDE_CODE_DISABLE_AUTO_MEMORY` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` are `1`. `CLAUDE_CONFIG_DIR`,
  `HOME`, and `USERPROFILE` name the directories of the seat.

**A user message is not a command.** Without `verbatimPrompts`, the
executable reads the file that an `@path` mention names. It does this with
no tool call and no permission check, and the file comes from the host
filesystem. It also runs a message that starts with `/` as a slash command.
A participant of the room could then pull any file of the host user into the
seat. With `verbatimPrompts`, the SDK marks each user message as composed by
the client, and the executable delivers the text as written.

**The executor refuses an executable older than 2.1.248.** An older
executable ignores the mark and reads the file. The `system` init message
names the version. When it is older, absent, or unreadable, the pass fails
with a permanent failure that names the version. The executor then closes the
query, so no model turn runs. The `session` step is already in the trace.
`MIN_CLAUDE_VERSION` in `src/failure.ts` holds the floor.

The query has no permission callback, so the executor raises no permission
request. The `approval` step belongs to the `approve` hook of `compose`. The
flag tier sits below the managed (policy) tier. A managed `attribution` can
still add text to a commit or a pull request. Auto-memory is off through both
the variable and the flag setting.

### What the environment holds

**The environment of the seat has four layers, in this order.**

1. **The base.** The variables of the host process that pass are `PATH`,
   `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `TEMP`, `TMP`, `TZ`, `LANG`,
   `TERM`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `COMSPEC`,
   `PATHEXT`, `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `http_proxy`,
   `https_proxy`, `no_proxy`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
   `SSL_CERT_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, and every name that starts with
   `ANTHROPIC_` or `LC_`.
2. **The overlay.** The `env` option of `claudeExecution`
   ([Options](#options)).
3. **The variables of the seat.** They win over `env`. `HOME` and
   `USERPROFILE` name the home directory of the seat. `CLAUDE_CONFIG_DIR`
   names its config directory. `CLAUDE_CODE_DISABLE_AUTO_MEMORY` applies
   before any settings tier, so a managed setting cannot turn auto-memory on.
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns off the update check and
   telemetry.
4. **The strip.** The executor removes the variables of a Claude Code
   session of the host.

The allowlist limits the environment variables of the seat. It does not limit
the filesystem. The host `HOME` does not pass. The `HOME` of the seat is the
`home` directory of its [seat directory](#config-home). The executable
reads no rc file or settings file of the host user.

**A host on Bedrock, Vertex, Foundry, or another provider must pass `env`.**
This holds when `ANTHROPIC_*` does not cover the provider. The allowlist
holds no `AWS_` and no `GOOGLE_` prefix, because those names carry broad cloud
secrets. Pass the variables that the provider needs, for example
`claudeExecution({ env: { AWS_REGION: 'eu-west-1' } })`. Without them, the
executable cannot sign in.

**A seat starts outside the Claude Code session of its host.** A host that
runs inside Claude Code holds variables such as `CLAUDE_CODE_SESSION_ID`
and `CLAUDE_CODE_REMOTE_SESSION_ID`. With them, every seat reports the id of
the host's session, and a resume opens one transcript for all seats. The
executor removes these variables, and `env` cannot bring them back. It also
removes `CLAUDE_CODE_ENTRYPOINT`, and the SDK then sets it to `sdk-ts`.

**A seat in a remote Claude Code environment needs its own key.** Without
`CLAUDE_CODE_REMOTE_SESSION_ID`, the executable does not wait for a rotated
host token after a 401. A seat that authenticates with the host's token can
then fail on a long query. Pass `ANTHROPIC_API_KEY` to such a seat.

### Tool aliases

**The executor routes a built-in name to the tool of the seat with the same
name.** A model can emit `Bash` out of habit. A skill text can name it too.
The executor passes `toolAliases` to the SDK. The call then lands on the
workspace tool, and it does not fail as unknown. The map holds `Bash` to
`bash`, `Read` to `read`, `Write` to `write`, and `Edit` to `edit`. An alias
exists only when the seat holds a tool of that name.

**An alias redirects the name and converts no argument.** The model sends the
arguments of the built-in tool, such as `file_path`. The tool of the seat
validates them against its own schema. A mismatch is a tool error that the
model reads. `Grep` and `Glob` have no alias, because the workspace has no
such tool.

## Config home

**Each seat has its own Claude config directory.** The executor sets
`CLAUDE_CONFIG_DIR` to `<seat directory>/config`. It uses
`<seat directory>/work` as the working directory of the process. It also makes
`<seat directory>/home` for `HOME`. It makes the three with mode `0700`, on
the first need. Every activation of the seat gets the same
directory, because a resume reads the session store there. Two seats get two
directories. The executable keeps its sessions, its settings, and on Linux
its credentials in this directory. No option changes the config home. A seat
never shares the config home, the sessions, or the sign-in of the host user.

**`configRoot` places the seat directories.** The seat directory is
`<configRoot>/<room>/<seat>`. A relative `configRoot` becomes absolute once,
against the working directory of the host, because the executable reads the
variable as it is. The room name and the seat name become one
path segment each. A prefix and a percent encoding remove every separator
and every dot, so no name leaves the root. Without `configRoot`, each seat
gets a private directory under the temporary directory of the host. Each
seat of each room start leaves one `ambion-claude-*` directory there, and the
executor removes none. A host that wants cleanup passes `configRoot` and owns
that directory. The directory does not survive a restart of the process or the
machine, and a resume after the restart falls back to a fresh session. Pass
`configRoot` to keep the sessions of a room across restarts. The executor
deletes no session file, and the host owns the cleanup.

## Exchange continuity

[Exchange continuity](executors.md#exchange-continuity) states the rule, the
recorded session, and the fresh start.

**Every query persists its session in the config home of the seat.** The
release records the id that the SDK reports. The id comes in a `system`
message or a `result`. An activation whose `spec.resume` names a Claude session passes it as
`resume`, with `forkSession` off. The SDK writes one session file for each
activation to its store, and the executor removes none.

**The first pass of a resumed activation sends the whole view.** The Claude
executor sends no delta on resume. The resumed session holds the earlier
record and the view again. `readThrough` starts at zero in each activation,
and a say against newer record gets a `missed` answer.

**The first message of a resumed query restates the seat's part.** A
resumed session keeps the system prompt it began with, and the SDK ignores
a new `systemPrompt`. The seat's duties and instructions for the
activation, its agent part, therefore go at the head of the first message.
A summary activation resumes the session of the exchange it summarizes.
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

[The step vocabulary](executors.md#the-step-vocabulary) holds the thirteen
step kinds. The table below gives the SDK source of each step. A message from
a subagent (`parent_tool_use_id` set) adds no step.

| Step          | Source in the SDK                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `thinking`    | `content_block_delta` events, then `content_block_stop`. A block the stream did not send arrives whole.                 |
| `text`        | The same events for a text block.                                                                                       |
| `tool_call`   | A `tool_use` block of an assistant message. One step for each id.                                                       |
| `tool_result` | A `tool_result` block of a user message. `is_error` adds `error` with the text of the result.                           |
| `session`     | The `system` init message of a session. `tools` holds the room tools by plain name. `auth` is the `apiKeySource` name.  |
| `steer`       | Never. The core records it. The executor calls `read` on the echo of a steered line.                                    |
| `approval`    | Never. The `compose` tool records it through the access of the activation.                                              |
| `usage`       | One for each top-level model request, from the `usage` of its `message_start`, `message_delta`, and assistant messages. |

## Usage and cost

**One `usage` step covers each model request of the top-level agent.** The
executor reads the token counts of a request from the `usage` of its
`message_start` event, its `message_delta` events, and its assistant
messages. The SDK can send several assistant messages with one id, and
their counts can be stale. The counts of one request only grow, so the
executor keeps the largest value of each count. A request has one step.

**A request ends when the next one starts, or when its tool results
arrive.** The step of a request comes before the first step of the next
request and before the tool results of the request. The last request ends
at the `result`. A request with no tokens adds no step.

**The `result` closes the last request.** The executor sums `modelUsage`
over every model of the result for `input`, `output`, `cacheRead`, and
`cacheWrite`. `cost` is `total_cost_usd`. The SDK reports running totals
for the query. The executor takes the difference from the earlier result
and subtracts the steps it already wrote. The last request takes the rest
and the whole cost, so the steps sum to the totals of the results. A pass
with no pending request writes the rest as its own step. The step is
absent when both tokens and cost stand at zero.

The known limits:

- **A subagent has no step of its own.** Its tokens and cost reach the
  trace through the step of the last request.
- **A request that reports more than the result keeps its own counts.**
  The steps then sum to more than the totals.
- **`cost` is the number that the SDK reports.** The executor does not
  compute it.
- **A resumed session may report totals of earlier activations.** The first
  result of an activation counts the whole total it carries.

## Failure classification

[Failure classification](executors.md#failure-classification) states the
shared rule and the text set. The text set holds the words of the Claude Code
login.

| Result                                                | Outcome                                        |
| ----------------------------------------------------- | ---------------------------------------------- |
| `error_max_budget_usd`                                | `permanent`                                    |
| `error_max_turns`, or a `stop_reason` of `max_tokens` | No failure. The pass reports `stop: 'length'`. |

**The executor reads a status only from `api_error_status`.**

**Every failed pass carries the end of the process stderr.** The message
gets the last 2,000 characters of the stderr of the query. This holds for a
failed `result`, for a query that ends early, and for a query that throws. A
failed `result` waits 50 milliseconds, because the stderr arrives on its own
pipe. The wait ends at once when the process ends or `close` runs. The class
comes from the result, the status, or the error, and never from the stderr
text.

## Testing

**A fake Claude Code executable tests the executor with no key.**
`@ambionframework/claude/testing` exports `claudeExecutorFixture` and
`scenarioOf`. The fixture runs the executor suite of
`@ambionframework/ambion/conformance` through the real driver. The SDK
spawns `test/fake/claude-executable.mjs` through
`pathToClaudeCodeExecutable`. The fake reads a scenario from `AMBION_FAKE`,
a JSON object whose `passes` field holds one list of actions for each user
message, and speaks the stream-json protocol of the SDK over stdio.

```ts
import { executorConformance } from '@ambionframework/ambion/conformance';
import { claudeExecutorFixture } from '@ambionframework/claude/testing';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';

// The path of a fake Claude Code executable that the caller supplies.
const executable = fileURLToPath(new URL('./fake/claude-executable.mjs', import.meta.url));

describe('claude executor', () => {
  for (const c of executorConformance(claudeExecutorFixture({ executable }))) it(c.name, c.run);
});
```

**The fake ships in the repository only.** The package publishes `dist`,
and `dist` holds no fake. The repository keeps its fake at
`packages/claude/test/fake/claude-executable.mjs`. A caller who wants the
same run writes a fake with the protocol above.

**What the fake cannot prove.** The fake does not enforce anything. It cannot
show that the real binary honors `--tools`, `--allowedTools`,
`--permission-mode`, `--strict-mcp-config`, or an empty setting source. It
cannot show the real `result` shape, the behavior of a real session store on
resume, or a real sign-in. A change of the pinned SDK or CLI version re-runs
`test/live/hermetic.test.ts`, because the CLI may narrow what `client_composed`
skips.

## Troubleshooting

[The shared table](executors.md#troubleshooting) lists the symptoms that
hold for every kind. These rows are specific to Claude.

| Symptom                                                               | Cause                                                                                                                                                                               |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The model cannot see `Bash` or `Read`                                 | A Claude seat has no built-in tool. Give the seat a workspace bundle. Its `bash`, `read`, `write`, `edit`, and `apply_patch` tools take the place.                                  |
| A project MCP server is missing                                       | `strictMcpConfig` is on. The query reads the room server only.                                                                                                                      |
| The seat is abandoned with an authentication text                     | A permanent failure. Pass `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`. A seat does not read the sign-in of `claude login`. A custom `env` may have set the key to `undefined`. |
| `The Claude session ended before the pass did.`                       | The process exited. Check `pathToClaudeCodeExecutable` and `env`. The message ends with the last 2,000 characters of the process stderr. The text never changes the failure class.  |
| A pass fails with `needs Claude Code 2.1.248 or later`                | `pathToClaudeCodeExecutable` names an executable below the floor. Use a newer one, or leave the option out to use the executable of the SDK.                                        |
| A failed pass names a model or a setting the executable does not know | The message ends with the stderr of the process, which often names the cause. For an unknown model, it says that the model catalog does not describe it.                            |
| A `bash` tool of the workspace finds no git identity                  | The seat has no `~` of the host user. The workspace backend owns the identity.                                                                                                      |
| The executable cannot sign in on Bedrock, Vertex, or Foundry          | The allowlist holds no variable of that provider. Pass an `env` with the variables that the provider needs.                                                                         |
| A pass ends 5 seconds after its result                                | A sent message had no echo yet. The grace period ended the pass.                                                                                                                    |
| The seat is abandoned with a budget text                              | `maxBudgetUsd` ran out. The failure is permanent. Raise the budget.                                                                                                                 |
