# Codex

`@ambionframework/codex` runs an Ambion seat on the Codex SDK. This page
holds what is specific to the Codex adapter. [Executors](executors.md)
holds the shared contract: the activation flow, the room tools, exchange
continuity, failure classification, the step vocabulary, and the trace. [The
Pi guide](pi.md) and [the Claude guide](claude.md) cover the other two
shipped executor kinds. [The
README](../README.md) holds the positioning.

## What the package is

**A seat that Codex runs.** `codex()` defines the executor of an agent.
`codexExecution()` gives a room or a runtime the services that run it.
Codex owns the model loop and its thread.

**A Codex seat has no native tools, ever.** Files and a shell come only from
the workspace tools, behind the workspace port, so it makes no difference
whether the workspace is in memory, a directory, or a remote workstation.
The seat reaches the world through the room tools and the tools that you
give it, as a Pi seat does. [Workspace](workspace.md#give-the-resource-to-an-agent)
states the workspace tools: `read`, `write`, `edit`, `bash`, and the
others. A seat of any executor kind joins one room.
[Executors](executors.md#the-executor-contract) states how a room resolves
an execution. Pass `codexExecution({ codexPath, env, home, login })` for
another binary, environment overlay, Codex home, or login.

**Three MCP helper tools remain.** Codex adds `list_mcp_resources`,
`list_mcp_resource_templates`, and `read_mcp_resource` whenever an MCP server
is on, and no setting turns them off on codex 0.158.0. They reach only the
MCP servers of the seat. The room tools server offers no resource, and it
answers each call with `Method not found`, so they read nothing. A unit
test of the server proves it with a `file:///etc/hosts` request.

**The kernel gains no dependency.** `@ambionframework/ambion` imports no model
library. `@openai/codex-sdk` and `@modelcontextprotocol/sdk` belong to this
package only, pinned to exact versions.

## Install and sign in

```sh
npm install @ambionframework/ambion @ambionframework/codex
```

**Node 22.19 or newer.** The package needs the same Node floor as every
Ambion library package. Codex spawns the room tools server with the Node
that runs your process.

**The `codex` binary comes with the SDK.** `@openai/codex-sdk` depends on
`@openai/codex`, which installs the binary for the platform. Set
`codexPath` on `codexExecution()` to run another executable.

**Sign in with one of two ways.**

- Set `CODEX_API_KEY` in the environment of the process. The binary reads it
  on each run.
- Run `codex login` once. The seats link the sign-in file that the command
  writes, `~/.codex/auth.json`. Sign in with ChatGPT to run on a ChatGPT
  Plus or Pro subscription. A host with no browser runs
  `codex login --device-auth`.

**A subscription needs no key.** Leave `CODEX_API_KEY` out of the
environment, so that the binary runs on the ChatGPT sign-in. The execution
finds `~/.codex/auth.json` under the `HOME` of the process, or under the
`HOME` that `env` sets. A `login` option names another file. A subscription
has its own usage
limit, which is a permanent failure. Codex reports no cost, so the executor
records none. A provider may restrict the use of a consumer subscription
outside its own clients. Read its terms first.

**The seats of an execution share a Codex home of their own.** The default home is
`~/.ambion/codex`, under the `HOME` of the host. The execution sets
`CODEX_HOME` to it for each run of the binary, and the `CODEX_HOME` of the
host never reaches the binary. A seat reads no `config.toml` and no
`AGENTS.md` from `~/.codex`, and it starts none of the MCP servers that
file names. The home persists, so a thread survives a restart of the host.
The execution creates the home when the first activation starts, with the
mode `0700`, because it holds full transcripts, logs, and the linked login.

**The home links the login of the host.** The first activation creates the
symbolic link `auth.json` in the home. It points to the login file of the
host: `auth.json` in the `CODEX_HOME` of the host when that
variable is set, else `~/.codex/auth.json`. Codex writes that file in
place, and it reads the file again before it refreshes a token. The host and
all seats then share one login. A copy would hold a refresh token that
Codex rotates, and the copy and the original would diverge.

**The link has rules.**

- A home that already holds an `auth.json` keeps it. The execution never
  replaces or edits that file.
- A host with no login file gets no link. A seat on `CODEX_API_KEY` needs
  none. `login: false` links nothing in any case.
- Where the host refuses symbolic links, such as Windows with no privilege,
  the execution makes a hard link. If both fail, the activation fails as
  permanent. The message names both paths.
- Several activations can start at once. A link that another activation made
  counts as success.

**A keyring login cannot be shared.** With `cli_auth_credentials_store`
set to `keyring`, or to `auto` on a host with a keyring, Codex stores the
login in the keyring under a key that holds a hash of the `CODEX_HOME` path.
A seat home has another path, so it finds no login. Set the store to `file`
in `~/.codex/config.toml` and run `codex login` again. Or sign in to the
home: `CODEX_HOME=~/.ambion/codex codex login`.

## A complete example

```ts
import { defineAgent, definePerson, isSaid, startRoom } from '@ambionframework/ambion';
import { codex } from '@ambionframework/codex';

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

const room = await startRoom({
  name: 'delivery',
  agents: [planner],
});
const visit = await room.visit(priya);
const exchange = await visit.send({ text: 'Is the plan ready?' });
const messages = await exchange.waitForClose();
console.log(messages.filter(isSaid).map((message) => message.text));
await room.stop();
```

**A seat gets files and a shell from a workspace.** Give the seat the tools
of a workspace in `bundles`. The tools run behind the workspace port, so the
backend is a choice of the host: in memory here, a directory, or a
workstation.

```ts
import { defineAgent } from '@ambionframework/ambion';
import { codex } from '@ambionframework/codex';
import { memoryBackend } from '@ambionframework/just-bash';
import { openWorkspace } from '@ambionframework/workspace';

const workspace = openWorkspace({ name: 'site', backend: { bash: memoryBackend() } });

const writer = defineAgent({
  name: 'writer',
  identity: 'Writes the notes of the site.',
  executor: codex({
    instructions: 'Keep the notes in your workspace, and say where they are.',
    model: 'gpt-5.6-luna',
    bundles: [workspace.tools()],
  }),
});
```

A test in the package typechecks these blocks against the source of the
package. The block in `packages/codex/README.md` gets the same check.

## Options

**`codex(options)` takes the fields of an agent and two settings of the
model.** The executor passes each setting to the Codex SDK unchanged.

| Option                 | Default            | What it does                                                        |
| ---------------------- | ------------------ | ------------------------------------------------------------------- |
| `instructions`         | Required           | The private voice of the agent                                      |
| `model`                | Required           | A Codex model identifier                                            |
| `tools`                | None               | Tools from `defineTool`. They reach Codex through the server        |
| `bundles`              | None               | Tool bundles with guidance                                          |
| `speaking`             | `DEFAULT_SPEAKING` | The speaking policy that replaces the default                       |
| `activationTokenLimit` | The whole record   | The token limit for the record one activation reads                 |
| `estimateTokens`       | `'length'`         | The name of the estimator in the runtime that counts tokens         |
| `modelReasoningEffort` | Codex default      | `minimal` up to `ultra`, as the SDK lists them                      |
| `reasoningSummary`     | `'auto'`           | `auto`, `concise`, `detailed`, or `none`: see "Debug an activation" |

**`estimateTokens` names an estimator in the runtime.** The room runs it
and windows the record, so the definition carries the name alone. `length`,
the default, counts `Math.ceil(text.length / 4)`. `createRuntime({ estimators })`
registers other names, and a room start fails on a name the runtime does not
hold. [History and limits](room.md#history-and-limits) states the rule.

**The executor fixes the policy of the thread.** A seat has no option for
it. The executor sets `sandboxMode` to `read-only`, `approvalPolicy` to
`never`, `networkAccessEnabled` to `false`, and `workingDirectory` to an
empty temporary directory. [The trust boundary](#the-trust-boundary) states
why.

**`codexExecution(options)` takes the options of the executable.**

| Option      | Default                                      | What it does                                                                              |
| ----------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `codexPath` | The bundled binary                           | A `codex` executable to run                                                               |
| `env`       | None                                         | Variables to lay over the allowlisted variables of `process.env`. `undefined` removes one |
| `home`      | `.ambion/codex` under the `HOME` of the host | The Codex home of every seat                                                              |
| `login`     | The `auth.json` of the host                  | The `auth.json` to link into the home. `false` links nothing                              |

**The binary runs with an allowlisted environment.** The base is the
variables of `process.env` that the next table names. The
`env` option lays over it: a value adds or replaces a variable, and
`undefined` removes one. Then the execution sets the variables of the seat,
and they win over `env`. The same environment goes to every run of the
binary, including the `codex debug models` run for the catalog.

**The allowlist holds what the binary needs to reach its provider.**

| Admitted by                                                                  | Why                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `PATH`, `USER`, `LOGNAME`, `TMPDIR`, `TEMP`, `TMP`, `TZ`, `LANG`             | The binary finds programs, writes temporary files, and formats time |
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, lowercase forms        | A host behind a proxy reaches the provider                          |
| `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`                       | A host with its own certificate store verifies the provider         |
| `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SYSTEMROOT`, `COMSPEC`, `PATHEXT` | The binary starts on Windows                                        |
| `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_CA_CERTIFICATE`                | The key, the token, and the certificate of Codex                    |
| `OPENAI_*`                                                                   | `OPENAI_API_KEY` and `OPENAI_BASE_URL` serve the default provider   |
| `LC_*`                                                                       | The locale                                                          |

**On Windows the allowlist compares names without case.** Windows spells
some variables in mixed case, such as `Path` and `SystemRoot`, and the
binary needs them to open a socket.

**Every other variable stays with the host.** `SHELL` and `TERM` are not on
the list, because a seat has no native tool and no terminal. Other `CODEX_`
variables, such as `CODEX_SQLITE_HOME` and `CODEX_SANDBOX`, move the state,
the sandbox, or a server of Codex out of the seat. A cloud key, a
token of a code host, and the socket of an SSH agent reach neither the
binary nor the room tools server that Codex starts. A provider with another
`env_key` in the `config.toml` of `home` needs that variable in `env`.

**The seat sets `CODEX_HOME`, `HOME`, and `USERPROFILE`.** `CODEX_HOME` is
`home`. `HOME` and `USERPROFILE` are the private directory `home/home`, which
the execution creates with the mode `0700`. Codex finds skills under
`$HOME/.agents/skills`. With a private `HOME`, a skill of the host user
reaches no prompt, and no dotfile of the host user is in the reach of the
binary. The login still works, because `auth.json` lives in `CODEX_HOME`.

**The defaults of `home` and `login` read the host.** The `HOME` and the
`CODEX_HOME` of the host are the values of `process.env` with `env` laid over
them. The `CODEX_HOME` of the host sets the default `login` to
`<CODEX_HOME>/auth.json`. Neither value reaches the binary.

**The executor always sets `skipGitRepoCheck`.** A room seat runs where the
application puts it, and that place is often no git repository.

## How a room tool reaches Codex

[Executors](executors.md#the-room-tools) states the room tools, the commit
key, and the room answers.

**Codex runs tools as MCP servers that it spawns.** The room tools (`say`,
`schedule`, `seat`, `unseat`, `dismiss`, `recall`) and the tools of the
agent live in the host. A small
stdio server bridges them.

```mermaid
flowchart LR
  C[codex exec] -- stdio MCP --> S[room-tools-server.mjs]
  S -- local socket --> B[bridge in the host]
  B --> T[room tools]
  T --> R[room commit]
```

1. The activation opens a socket in the temporary directory.
2. The executor passes the server command and the socket path to Codex in
   the config key `mcp_servers.ambion`.
3. The server connects to the socket and asks for the manifest: each tool
   with its description and its JSON Schema.
4. The server lists those tools to Codex and sends each call over the
   socket. The bridge runs the call on the tool that the core bound, takes
   the id of the call with `callId`, and returns the result.
5. `close` stops the socket. The server exits when the socket closes.
   It first stops `codex exec` if that process is still its parent.

**Codex spawns the built server.** The package ships
`dist/room-tools-server.mjs` and starts it with `node`. In the source tree
the same path resolves to `src/room-tools-server.ts`, which Node runs by
stripping types. `serverPath` picks the file from the extension of the module
that calls it, and a test covers both cases.

**The config key sets two limits, one flag, and one mode.**
`startup_timeout_sec` is 30. `tool_timeout_sec` is 600. `required` is
`true`. `default_tools_approval_mode` is `approve`.

**A required server is ready before the first model request.** Codex starts
its MCP servers in the background. For an optional server, it waits one
second (`mcp_optional_startup_grace_ms`) and then sends the first request
with the tools that exist at that time. A Node process on a loaded host
needs more than one second, so that request listed no room tool. With
`required = true`, Codex waits for the server up to `startup_timeout_sec`
while it creates the session. The room tools are then ready before the
first model request, and a seat lists them on every request. The binary
tier asserts it.

**Approval is set because a headless run cannot answer.** Under
`approvalPolicy: 'never'`, Codex denies an MCP call that needs approval. The
real binary answers every `say` with "MCP tool call requires approval, but
approval policy is never", and the seat answers in plain text that the room
never records. The room tools belong to the seat, so the config approves
them.

## How an activation runs

[Executors](executors.md#the-executor-contract) states the pass flow.
[How an activation runs](executors.md#how-an-activation-runs) states the
read position. Codex sends no echo of the prompt.

**The client config of an activation carries the seat's part.** The Codex
SDK has no system prompt option, so the executor puts the seat text in the
config of the client. The seat text is the harness note, the mechanism, and
the agent instructions, in that order, with a blank line between them. The
core fixes all three for an activation, so the executor builds the text once,
from the first pass. The first prompt holds the whole view. A later pass sends
the delta, the lines that landed since the pass read, as the next run of the
same thread. A pass runs one Codex turn. The `turn.*` events of Codex mark
each pass.

**The seat text is an instructions file.** The config key
`model_instructions_file` names a file in the scratch directory of the
activation. The file replaces the base prompt of Codex, which teaches
`apply_patch` and the shell. A seat has no native tools and needs nothing
from the base prompt. The SDK passes the path, and Codex reads the file as
written, so quotes, backslashes, newlines, and non-ASCII characters arrive
unchanged. The binary tier proves it.

**A pass ends on `turn.completed` or `turn.failed`.** Codex also sends `error`
events for trouble that it survives, such as a reconnect. An `error` event
ends the pass only when nothing else does.

**`turn.started` is the signal that the model read the prompt.** The model
reads the prompt when a pass starts, so the executor calls `read` with the
range of the view or the delta then. A tool result reaches the model when
the tool returns, so the executor calls `delivered` at once. A missed say
moves the position to the last of the messages it carries, and a
`schedule` moves it to the scheduled say; see
[Executors](executors.md#how-an-activation-runs).

**Codex takes no steer.** [The harness matrix](executors.md#the-harness-matrix)
states what an executor kind without steering does. The Codex session has no
`steer` method, and the seat reads a line on the next delta pass. The core
records the `steer` step of that line with `consumed: false`; see
[Executors](executors.md#how-an-activation-runs).

**A cut signals the pass.** The signal of the activation signals the pass in
flight. `close` stops the socket and the server. A late cut signals no dead
process.

**A host that dies takes `codex exec` with it.** The SDK closes the input of
`codex exec` at once. When the host process dies (SIGKILL, out of memory, a
crash), the OS gives `codex exec` to init and the process runs its pass to the
end. It keeps calling the model and keeps writing the thread. The
room tools server sees the host socket close. If `codex exec` is still its
parent, the server sends it SIGTERM and then exits. A `codex exec` that
exited first has left the server to init, so the server sends no signal. On
Windows, Node cannot tell that the parent is gone, so this guard holds on
Linux and macOS only. A test kills a real host in the middle of a model request and proves that
`codex exec` and its server go away within seconds.

## Step mapping

[Executors](executors.md#the-step-vocabulary) holds the eleven step kinds. The
table below gives the Codex source of each step.

**Each item that Codex reports becomes steps in the trace.** Codex reports an
item as it starts, as it changes, and as it completes. A text item carries the
whole text so far, so the steps hold the growth: one delta for each update,
then a closing step.

| Codex item or event | Steps                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `agent_message`     | `text` deltas, then a closing `text`                                                            |
| `reasoning`         | `thinking` deltas, then a closing `thinking`                                                    |
| `mcp_tool_call`     | `tool_call` and `tool_result`; a room tool has its own name                                     |
| `error` item        | `notice` at level `warning`, with the message of Codex, up to 2000 characters                   |
| `error` event       | `notice` at level `warning`, with the message of Codex, up to 2000 characters                   |
| Any other item      | `notice` at level `warning` that names the item type, when the item completes                   |
| `turn.started`      | Once for each thread: `notice` at level `info`, with the thread, the home, and the rollout file |
| `turn.completed`    | `usage`                                                                                         |
| `turn.failed`       | No step; the failure goes to the `end` step                                                     |

**The id of a step is unique in the room.** A real `codex` numbers the items
of each pass from `item_0`. The id of a step holds the activation id, the
number of the pass, and the item id, as in `message:3:gpt:1:1:item_1`. A room
tool takes that id as the key of its commit, so the say of each activation
lands under its own key.

**A failed tool call marks its result.** A failed MCP call gives the
message that Codex reported.

**A tool of another server shows with its server.** The step name is
`server__tool`. A room tool shows with its plain name, such as `say` or
`schedule`. The core raises no tool event for a room tool that commits an
entry; see [Executors](executors.md#the-room-tools).

**An item of another type shows that a native tool exists.** A seat has no
native tool, so Codex reports only the items above. A command, a file
change, a web search, or a plan item means that a newer `codex` added a tool
that the recipe does not turn off. The trace keeps a warning `notice` with
the item type. The executor maps nothing else from such an item.
[The trust boundary](#the-trust-boundary) states the guard.

**A notice never gates the activation.** Codex reports its own diagnostics
as `error` items and `error` events, such as an unknown setting in the
config or "Reconnecting... 1/5". The trace keeps each one as a `notice` at
level `warning`. A pass that fails ends with an `error` event and then
`turn.failed`. The `end` step carries that failure, and the `error` event
also shows as a `notice` with the same text.

## Usage

**One `usage` step ends each pass.** `turn.completed` reports input, cached,
and output tokens. [Executors](executors.md#the-step-vocabulary) states how
the driver sums the steps at release. The activation reports the sum on
`activation_end`.

**Codex reports no cost.** The `cost` field of `usage` stays absent. A room
that budgets on cost needs its own price table.

**Input tokens include the cache.** The recorded runs show it. A first run
reports 12387 input tokens and 12384 cache writes. The count is

```text
input      = input_tokens - cached_input_tokens - cache_write_input_tokens
cacheRead  = cached_input_tokens
cacheWrite = cache_write_input_tokens
output     = output_tokens
```

The three parts add up to `input_tokens`. A count that subtracts only the
cached tokens counts the cache writes twice.

**Known limits.** The count ignores `reasoning_output_tokens`. The recorded
runs do not show whether `output_tokens` includes them. A field that an older
`codex` omits counts as zero.

## Debug an activation

**The trace shows each step of the model.** Give the `logger` option of
`createRuntime` a function that keeps the steps. Each activation logs its
`thinking`, `text`, `tool_call`, and `tool_result` steps, the `room`
answers, and the `usage`. The `end` step
holds the failure of a pass that failed.

**The reasoning summary feeds `thinking`.** Codex shows no raw reasoning.
It shows a summary that the model writes when the request asks for one. The
catalog of some models turns the summary off, so the executor asks for it:
`reasoningSummary` is `auto` by default and goes to Codex as
`model_reasoning_summary`. `concise` and `detailed` set the size. `none`
asks for no summary, and the request then has no `reasoning.summary` field.

**The default trace policy cuts each thinking block to 280 characters.**
[Executors](executors.md#the-trace-log) states the policy. Set
`defineAgent({ trace: { thinking: 'full', toolOutput: 'full' } })` to keep
all of each block while you debug.

**One `notice` joins the trace to the full record of Codex.** The notice
has the text "Codex thread" and the level `info`. Its `data` holds the
`thread` id, the `home` of the seat, and the `rollout` path. The rollout is
the file `<home>/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. It
holds the instructions, every input and output item, the reasoning, and the
tool calls. The executor looks for the file after the pass starts. It leaves
out `rollout` when it finds none. Each thread has one notice for the
activation.

**Codex keeps its own logs in the seat home.** `logs_2.sqlite` in the home
holds the log of the `codex` process. The stderr of `codex exec` is not
visible when the run succeeds.

## Failures

[Executors](executors.md#failure-classification) states the shared rule.

**Codex reports a failed pass as text, with no status field.** The
`turn.failed` and `error` events carry a message only. The classification
pulls a three-digit HTTP status out of the text when the text names one,
such as "status 401", and applies the shared status rule to it.

**The shared classifier reads the text.** The
[text set](executors.md#failure-classification) holds the words of the
Codex login.

**A text that names a full context window or a spent output limit reports
a length stop.** The pass reports `stop: 'length'`. This is no failure.

**A stream that ends with no terminal event is a transient failure.** A
failure reaches the host as an `error` event before the driver sees it.

**A missing `codex` binary is permanent when the executor looks for it.**
The executor reads the model catalog from the binary. It throws `PermanentError` when the platform has no binary, or
when `@openai/codex` is not installed and no `codexPath` is set.

**A room tools server that fails to start is transient.** The server is
`required`, so `codex exec` exits with an error that starts "required MCP
servers failed to initialize: ambion". The SDK throws it, and the executor
reports a transient failure. The room retries the activation. Codex has sent
no model request at that time.

**A bad `codexPath` or a socket error is transient.** The executor uses a
`codexPath` (see [Options](#options)) as given. A path that names no file
fails when `codex debug models` or the SDK starts it, and that failure is
transient. A lost connection to the room
tools server is transient.

## Exchange continuity

[Executors](executors.md#exchange-continuity) states the rule, the recorded
session, and the fresh start.

**An activation resumes the thread that `spec.resume` names.**

- The release records the thread id from the `thread.started` event.
- An activation whose `spec.resume` names a Codex thread calls
  `resumeThread(id)`. Every other activation starts a fresh thread.

**A resume that Codex cannot honor starts a fresh thread.** Such a resume fails
before `thread.started`. The executor then starts a fresh thread, runs the
same prompt, and records the new id. A failure after `thread.started` is an
ordinary failure.

**A resumed thread takes the seat text of its own activation.** This is a
fact about Codex 0.158.0, from two runs of `codex exec` against a scripted
endpoint: one run starts a thread with text A, and `codex exec resume <id>`
runs it again with text B. With `model_instructions_file`, the second
request holds text B and no text A. The first prompt of a resumed
activation holds the view alone, as the first prompt of a fresh thread
does. If the resume fails, the fresh thread runs the same prompt.

**Threads live in the Codex store of the seat home.** The SDK persists
threads under `sessions` in the home, `~/.ambion/codex/sessions` by default.
A host that loses that directory falls back to a fresh thread. A thread that
an earlier version started under `~/.codex/sessions` is not in the seat home,
so it starts fresh. Give `home` a directory that persists. Codex refuses to
create its helper binaries under a temporary directory.

## The trust boundary

**A seat has no native tools, ever.** Files and a shell come only from the
workspace tools, behind the workspace port, so it makes no difference
whether the workspace is in memory, a directory, or a remote workstation.
The seat has the room tools (`say`, `schedule`, `seat`, `unseat`,
`dismiss`, `recall`) and the tools of `tools` and `bundles`. Every Codex seat
has the same kind of tools. No option gives a seat the shell, the file
edits, the web search, or the sandbox of Codex, and the workstation backend
needs no separate guard against a native command.

**Code Mode ignores the sandbox.** This is a fact about Codex 0.155.1, and
the reason that the recipe patches the catalog.
Code Mode is a JavaScript runtime that the model calls through `exec` and
`wait`. On a read-only sandbox, with no network and a deny permission
profile, its JavaScript still read `/etc/hosts` and listed `/Users` through
`fs`. It could not start a process or reach the network. `sandboxMode` and
permission profiles do not confine it. The run on 0.155.1 is the only
evidence of the file reads. A run of the 0.158.0 binary shows that a feature
flag still cannot turn Code Mode off. With the unpatched entry of
`gpt-5.6-luna` and every listed feature off, the model gets `exec` and `wait`
and no room tool, and Codex warns that Code Mode fails closed. The model
catalog turns it on: `gpt-5.6-luna` has `tool_mode: 'code_mode_only'`.
`gpt-5.5` has no tool mode.

**An image from a tool of the seat reaches the model.** A tool that returns
an image part, such as the workspace `read` of a picture, sends the image to
a model that reads images. Codex puts it in the tool output as an
`input_image`, and the trace keeps the part. No native tool reads an image,
because the `view_image` feature is off. A model with no image input in its
catalog entry stays text-only. Codex then replaces the image with a text
placeholder.

**The recipe replaces the catalog entry.** A custom catalog overrides the
entry of a model. The executor runs `codex debug models` on the installed
binary once for each binary in the process and patches the entry of the seat
model. It writes the patched catalog to a temporary directory and passes the
path as `model_catalog_json`. The recipe has five parts:

1. **The catalog entry.** `tool_mode`, `apply_patch_tool_type`, and
   `multi_agent_version` are `null`. `supports_search_tool` and the three
   `include_*_usage_instructions` flags are `false`. `node_repl_disabled` is
   `true`. `experimental_supported_tools` is empty. This removes Code Mode,
   the patch tool, and the search tool. The patch leaves `input_modalities`
   and `supports_image_detail_original` as the entry has them.
2. **The features.** The config sets 37 features to `false`, among them
   `shell_tool`, `unified_exec`, `code_mode`, `code_mode_only`, `apps`,
   `plugins`, `computer_use`, `multi_agent`, `hooks`, and `view_image`. This
   removes the shell and the tools that a feature adds. Five of them give
   no tool: `shell_snapshot`, `daemon_auto_start`, `workspace_dependencies`,
   `worktrees`, and `realtime_conversation`. Each acts on the host or the
   network. `shell_snapshot` runs the shell of the host user and writes its
   environment to a file in the seat home. `memories` is off by default, and
   the entry keeps the `config.toml` of the seat home from turning it on.
   Codex 0.158.0 turns `unified_exec` on again unless a managed requirement
   pins it. With `shell_tool` off, `unified_exec` adds no tool, and the
   tool-list test shows it.
3. **The tool switches and the skills.** `web_search` is `'disabled'`.
   `update_plan` and `experimental_request_user_input` are disabled.
   `skills.include_instructions` and `skills.bundled.enabled` are `false`,
   so no `skills_instructions` message reaches the model and Codex installs
   no system skill in the seat home. The catalog flag
   `include_skills_usage_instructions` does not remove that message on
   0.158.0.
4. **The bundled REPL.** Codex adds a `node_repl` MCP server. The config
   declares `mcp_servers.node_repl` as disabled, by name, beside the room
   server. Without it the tool list holds `mcp__node_repl.js`.
5. **Defense in depth.** The thread runs on a read-only sandbox, with no
   network, no approval, and an empty temporary directory as its working
   directory. No repository and no host file is the default context.

**The recipe turns off the traffic and the state that a seat does not
need.** `check_for_update_on_startup`, `analytics.enabled`, and
`feedback.enabled` are `false`. Only the terminal interface of Codex reads
`check_for_update_on_startup`, and `codex exec` starts no update check. The
config sets the key so that a later version keeps the same behavior. `memories.generate_memories` and
`memories.use_memories` are `false`, and so is the `memories` feature. Codex
0.158.0 recognizes each key and reports no warning for it. With a dummy API
key, a run makes no request except the model requests and opens no outbound
connection, with these keys. The binary tier asserts it.
A seat on a ChatGPT sign-in is the case that the keys protect, and the
binary tier does not run it.

The temporary directory of each activation holds the patched catalog, the
file with the seat text, and the empty working directory. The executor removes it when the activation closes,
and at process exit.

**A model with no catalog entry does not start.** The activation fails as
permanent. The message names the model. The executor never leaves native
tools on by accident. Use a model that `codex debug models` lists.

**The version pin guards the recipe.** The package pins `@openai/codex-sdk`
0.158.0, which brings `codex` 0.158.0. The feature names, the config keys,
and the catalog fields belong to that version. A newer `codex` can add a
native tool that the recipe does not turn off, and it can drop a key that
the recipe sets. Codex then warns about the key. The binary tier asserts
that a default seat produces no warning `notice` and no skills block, so
such a change fails a test. Run that tier and the live exclusivity test
(`test/live/exclusive.test.ts`) against a new version, and trust the
version only when both pass. A native item that Codex reports shows in the
trace as a warning `notice`.

**Features that stay on by default give no tool.** `codex features list`
on 0.158.0 shows 15 more features that are on and not in the recipe. They
are the app features, the approval features, `auth_elicitation`,
`fast_mode`, and a few wire features. None adds a tool or reaches the host.
The comment on `EXCLUSIVE_FEATURES` names each one. The list also prints
nine removed flags as on, such as `steer` and `sqlite`. A removed flag has
no effect. A new default feature
needs the same check on each upgrade.

**The environment is an allowlist.** The binary runs with the allowlisted
variables of `process.env`, the `env` of the host laid over them, and the
variables of the seat. `CODEX_API_KEY` and `OPENAI_API_KEY` pass by prefix.
Pass `OPENAI_API_KEY: undefined` and `CODEX_API_KEY: undefined` in `env` to
keep both from the `codex` process, and sign in with `codex login`. No
other secret of the host reaches the binary or the room tools server.

**The seat home keeps the config of the host user out.** The binary reads
its config, its instructions, and its MCP servers from `CODEX_HOME`. The
execution points that variable at the seat home, so the `~/.codex` of the
host user changes no seat: its `model_provider` reroutes no request, its
`mcp_servers` start no process, and its `AGENTS.md` joins no prompt. The
binary tier proves each of the three. Put a `config.toml` in `home` to
configure every seat on purpose. The private `HOME` does the same for the
skills of the host user under `~/.agents/skills`.

**The `config.toml` of the seat home is the responsibility of the host.**
The executor overrides each config key that the recipe names. Any other key
in that file survives by a deep merge. An extra `[mcp_servers.<name>]`
table starts a server whose tools reach the host, and a
`features.<name> = true` entry turns on a feature that the recipe does not
list. The default home `~/.ambion/codex` holds no `config.toml` until a
person writes one. Write only keys that you trust.

**A linked login is shared with the host.** The seat home holds a link to the
login file of the host. A seat has no native tool, so no tool of the seat
reads or writes the seat home. The workspace tools reach the workspace
only. Set `login: false` and `CODEX_API_KEY` to give a seat no login file.

**The room tools are approved.** They only call the room, and the room
checks each call.

## Testing

**Three tiers test the package.** Recorded events and the real binary on a
scripted model run in the unit tier. The live tier runs the real binary on a
real model.

**The binary tier scripts the model.** `codex` accepts a custom model
provider through its config. A local HTTP endpoint in `test/responses.ts`
speaks the Responses API and plays one reply for each request: assistant
text, or a call to a named tool. It records the body of each request. The
tests in `test/binary.test.ts` run the bundled `codex`, its MCP client, the
room tools server, the bridge, and a room over a journal. Only the model is
scripted.

**The binary tier runs in a seat home of its own.** `test/binary.ts` writes
a temporary home with a `config.toml` that sends the provider to the
endpoint, and passes it as `home`. The file leaves every other key to the
recipe, including the update check. The environment of the binary holds
`PATH`, a dummy key variable, and a proxy that records and refuses every
outbound connection, laid over the allowlist. The catalog lookup
(`codex debug models`) runs in the same environment. No real sign-in reaches
the binary, and every model request goes to the endpoint. The file skips on
a platform with no bundled binary, except under CI, where it fails.

**The host home holds traps.** Its `.codex` has a `config.toml` that
reroutes the provider to a dead port and starts an MCP server that writes a
marker file, an `AGENTS.md` with a unique text, and a skill under
`.agents/skills` with another. A test asserts that the endpoint got the
requests, that the marker file does not exist, and that neither text is in a
request body. `test/home.test.ts` asserts which variables reach the binary.

**The login test uses an API key file.** A host `auth.json` holds an API
key, and the provider takes the sign-in of the home. The test asserts that
every request carries the key of the host file, that the home holds a
symbolic link to that file, and that the file is as it was. A ChatGPT login
file makes Codex connect to `chatgpt.com`, so the test does not use one. The
proxy would show it. `test/home.test.ts` covers the rest of the rules of the
link on real files.

**A scripted call names the namespace of an MCP tool.** The model calls a
room tool with `name: 'say'` and `namespace: 'mcp__ambion'`. A call with the
name alone gets the tool result `unsupported call: say`, and nothing reaches
the room.

**Every request lists the room tools.** The config marks the room tools
server as `required`, and Codex waits for it before the first model request.
The endpoint does not retry or skip a request that lacks a tool. A request
without `say` gets the result `unsupported call`, and the assertions on the
request count and on the tool list fail. A test ran the tier on 4 cores with
24 busy loops. Without `required`, every run had requests that listed no
room tool. With `required`, every run passed.

**A room tools server that cannot start fails the pass.** One test points
the server at a command that does not exist. Codex exits with "required MCP
servers failed to initialize: ambion", before it sends a model request. The
pass reports a transient failure, and the test asserts the message.

**The binary tier proves what the model receives.** The recorded request
bodies show the tool list, the prompts, and the items of an earlier pass.
A default seat receives the seat text as the first developer message, and no
developer message starts with "You are Codex". The last user message holds
the view alone. No request holds a `skills_instructions` message or the name
of a system skill. Today Codex lists the tools in an `additional_tools`
input item. The
top-level `instructions` field of the request stays empty. A test states each
of these facts, so a change to one shows in a failing assertion.

**The binary tier asserts that a default seat gets no warning.** Two tests
run a default seat and assert that the trace holds no `notice` at level
`warning`. Codex reports an unrecognized config key as an `error` item, and
the executor maps it to such a notice. A key that a newer `codex` drops
shows as a failing test. Another test adds an unknown key to the home and
asserts that the warning names it, so the check cannot pass by silence.

**The binary tier sends the seat text unchanged.** One test sends a seat
text with quotes, backslashes, a newline, and non-ASCII characters. It
asserts that the text arrives unchanged as the first developer message.

**The binary tier proves the rule on the workspace tools.** One test gives a
seat the workspace tools over the in-memory backend. The scripted model
calls `write` and then `bash` to read the file back, and then `say`. The
test asserts that the tool list holds the workspace tools beside the room
tools and no native tool, that the file exists in the workspace when the
port reads it, and that the output of `bash` reaches the model in the next
request.

**The binary tier cannot prove that a model obeys.** A scripted model does
what the script says. The live tier proves the claims that need a real model.

**The live tier runs the executor suite.** The live file
`test/live/conformance.test.ts` runs the suite through
`codexExecutorFixture` in `test/live/support.ts`: the model follows each
plan from its instructions. A key that the provider refuses gives the
permanent failure, and a `codex` binary that does not exist gives the
transient one. The package has no `./testing` entry, because a fake `codex`
proves only that the adapter agrees with its own guess about the SDK.

**A dump shows what a live case saw.** Set `AMBION_LIVE_DUMP=<dir>` to write
one JSON file for each case of the live suite. The file holds the room calls
with their answers, every step, and for each activation the prompt of each
pass and each call that the executor made to the core. Without the
variable, the suite writes nothing.

**The unit tests run on recorded events.** `test/fixtures/` holds event
streams that a real `codex` 0.155.1 produced through the SDK 0.155.1, on the
model `gpt-5.6-luna`. Nobody has recorded them again on 0.158.0. The catalog
fixture `catalog-0.158.0.json` comes from the bundled 0.158.0 binary. The
tests map the events to steps and count usage. Pure parts have their own tests: the wire framing, the
room tools, the options, and the failure classification. A replay client
runs the executor on the recorded events to test exchange continuity. A
pass of the replay client can also call `say` through the socket of the
bridge, as the room tools server does.

**The live tier proves the claims that a scripted model cannot.** Each file
holds the smallest room that proves one claim.

| File                            | Claim                                                                                               |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `test/live/loop.test.ts`        | A seat speaks through `say`; no approval error; usage above zero                                    |
| `test/live/tools.test.ts`       | A seat writes a file and runs a command through the workspace tools, and says what the command read |
| `test/live/exclusive.test.ts`   | A seat has exactly the room tools and its own; it reads no host file                                |
| `test/live/image.test.ts`       | An image from a tool of the default seat reaches the model, and the seat names its color            |
| `test/live/steer.test.ts`       | A line sent during a pass is held, and the next pass reads it                                       |
| `test/live/memory.test.ts`      | Each exchange starts a fresh thread and records it; a bogus id falls back                           |
| `test/live/mixed.test.ts`       | A Pi seat and a Codex seat both speak                                                               |
| `test/live/visibility.test.ts`  | The trace holds the reasoning summary, and one notice names the thread and its rollout file         |
| `test/live/conformance.test.ts` | The executor suite of `@ambionframework/ambion/conformance`, with no steer and no usage plan        |

**Run the live tier in one of two modes.** Every definition sets the model
`gpt-5.6-luna` and `modelReasoningEffort: 'medium'`.

| Mode    | Sign-in                         | Pays                     |
| ------- | ------------------------------- | ------------------------ |
| `key`   | `CODEX_API_KEY` is set          | The API account          |
| `login` | `codex login` wrote `auth.json` | The ChatGPT subscription |

The key wins when the host has both. A file skips when the host has
neither. Unset `CODEX_API_KEY` to run on the login.

```sh
CODEX_API_KEY=... pnpm --filter @ambionframework/codex run test:live
pnpm --filter @ambionframework/codex run test:live   # on the login
```

The script builds the package first, because Codex spawns the built server.
The mixed file also needs the key of the Pi model (`AMBION_MODEL`, default
`anthropic/claude-sonnet-5`). A live run costs money: run one file with
`pnpm --filter @ambionframework/codex exec vitest run --config
vitest.live.config.ts test/live/loop.test.ts`.

## Troubleshooting

**The seat answers in its final message and nobody hears it.** Codex has its
own final-answer channel. The room hears only `say`. The harness note at the
start of the seat text says so. A seat that still ends with plain text and no `say` shows a
`text` step and no `tool_call` in its trace, and `activation_end` reports
`said: false`.

**Every say is denied.** The seat answers in plain text, and the record holds
nothing. The trace shows a `tool_result` with "MCP tool call requires
approval". The config key `default_tools_approval_mode` must be `approve`. A
custom `config` that replaces `mcp_servers` removes it.

**The server does not start.** Codex waits up to 30 seconds. It then exits
with "required MCP servers failed to initialize: ambion", and the activation
fails as transient. A server that exits at once fails the activation at
once. Check that `dist/room-tools-server.mjs` exists beside `dist/index.mjs`
and that `node` on the `PATH` of the process is Node 22.19 or newer. Run
`node dist/room-tools-server.mjs /tmp/none.sock` to see its error.

**The Node version is too old.** The package needs Node 22.19 or newer, and Node
strips types from `.ts` files only in the source tree. An older Node fails on
a built package with a syntax or an engine error.

**A thread cannot resume.** The executor starts a fresh thread and the seat
loses what the old thread held. The record still holds every line. Look for a
missing `sessions` directory in the seat home, a changed `home` option, a
`codex` of another version, or a different account than the one that started
the thread.

**A run fails with a sign-in message.** The failure is permanent, so the room
does not retry. Set `CODEX_API_KEY`, or run `codex login`. A `HOME` that
`env` sets moves the default `login`. A login in the OS
keyring is invisible to a seat: see "A keyring login cannot be shared".

**`Cannot link .../auth.json to the login file ...`** The activation could
make neither a symbolic link nor a hard link, and the failure is permanent.
Run `CODEX_HOME=<home> codex login` to sign in to the home, or pass
`login: false` and set `CODEX_API_KEY`.

**A seat starts with no login although the host has one.** The host login
file is `<CODEX_HOME>/auth.json` when the environment of the host sets
`CODEX_HOME`, else `~/.codex/auth.json`. Check that path, or pass `login`.

**`Cannot run an executor of kind '...': this seat needs 'codex'.`** A Pi or
Claude seat reached a Codex executor through an execution with no kind.
Pass the execution of each executor kind.

**A native tool shows up after a Codex upgrade.** The seat lists or calls a
tool that is not a room tool and not one of yours, and the trace holds a
warning `notice` that names an item type. A newer `codex` added a
feature or a catalog field that the recipe does not cover. Run the binary
tier (`test/binary.test.ts`), which asserts the exact tool list and no
warning `notice` for a default seat, and run `test/live/exclusive.test.ts`
to see the name. Compare `codex debug models` and `codex features list` of
the new version with `src/catalog.ts`. Add the feature or the field, and keep
the version pinned until both tests pass. A warning that names a config key
means that the new version dropped the key: remove it from
`exclusiveConfig`.
