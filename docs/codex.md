# Codex

`@ambionframework/codex` runs an Ambion seat on the Codex SDK. This page is
the full guide to the package. [`README.md`](../README.md) holds the
positioning of Ambion. [Executors](executors.md) holds the executor
contract that the package implements.

## What the package is

**A seat that Codex runs.** `codex()` defines the executor of an agent.
`codexExecution()` gives a room or a runtime the services that run it. Codex
owns the model loop and its thread. The room owns the record, the rules, and
the freshness of every say.

**A seat has no native tools by default.** It reaches the world only through
the room tools and the tools that you give it, as a Pi seat does. Set
`nativeTools: 'codex'` to give the seat the tools of Codex: file edits,
shell commands, and web search. Both kinds of seat join one room. A room
whose seats run on more than one family passes `composeExecutions` from
`@ambionframework/ambion/hosting`.

**Three MCP helper tools remain.** Codex adds `list_mcp_resources`,
`list_mcp_resource_templates`, and `read_mcp_resource` whenever an MCP server
is on, and no setting turns them off on codex 0.155.1. They reach only the
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

**Node 26.4 or newer.** The package needs the same Node floor as every
Ambion package. Codex spawns the room tools server with the Node that runs
your process.

**The `codex` binary comes with the SDK.** `@openai/codex-sdk` depends on
`@openai/codex`, which installs the binary for the platform. Set
`codexPath` on `codexExecution()` to run another executable.

**Sign in with one of two ways.**

- Set `CODEX_API_KEY` in the environment of the process. The binary reads it
  on each run.
- Run `codex login` once. The binary reads the sign-in from `~/.codex`.

## A complete example

```ts
import { defineAgent, defineHuman, isSpoken, startRoom } from '@ambionframework/ambion';
import { codex, codexExecution } from '@ambionframework/codex';

const planner = defineAgent({
  name: 'planner',
  identity: 'Reads the plan and names what is missing.',
  executor: codex({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'medium',
    memory: 'seat',
  }),
});

const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const room = await startRoom({
  name: 'delivery',
  agents: [planner],
  execution: codexExecution(),
});
const visit = await room.visit(priya);
const exchange = await visit.send({ text: 'Is the plan ready?' });
const messages = await exchange.waitForClose();
console.log(messages.filter(isSpoken).map((message) => message.text));
await room.stop();
```

A test in the package typechecks this block against the source of the
package. The block in `packages/codex/README.md` gets the same check.

## Options

**`codex(options)` takes the fields of an agent and the policy of Codex.**
The executor passes each policy field to the Codex SDK unchanged.

| Option                  | Default            | What it does                                                 |
| ----------------------- | ------------------ | ------------------------------------------------------------ |
| `instructions`          | Required           | The private voice of the agent                               |
| `model`                 | Required           | A Codex model identifier                                     |
| `tools`                 | None               | Tools from `defineTool`. They reach Codex through the server |
| `bundles`               | None               | Tool bundles with guidance                                   |
| `speaking`              | `DEFAULT_GUIDANCE` | The speaking policy that replaces the default                |
| `activationTokenLimit`  | The whole record   | The token limit for the record one activation reads          |
| `estimateTokens`        | Length estimate    | How the agent counts tokens against its limit                |
| `memory`                | `'activation'`     | `'seat'` resumes one thread for the seat                     |
| `nativeTools`           | `'none'`           | `'none'` turns off every native tool; `'codex'` keeps them   |
| `sandboxMode`           | Codex default      | `read-only`, `workspace-write`, or `danger-full-access`      |
| `approvalPolicy`        | Codex default      | `never`, `on-request`, `on-failure`, or `untrusted`          |
| `modelReasoningEffort`  | Codex default      | `minimal` up to `ultra`, as the SDK lists them               |
| `networkAccessEnabled`  | Codex default      | Whether a command may use the network                        |
| `workingDirectory`      | Process directory  | The directory where Codex works                              |
| `additionalDirectories` | None               | More directories that Codex may write                        |

**`nativeTools: 'none'` fixes the policy.** The executor then sets
`sandboxMode` to `read-only`, `approvalPolicy` to `never`,
`networkAccessEnabled` to `false`, and `workingDirectory` to an empty
temporary directory. It ignores those four options and `additionalDirectories`.
They apply only with `nativeTools: 'codex'`.

**`codexExecution(options)` takes the runtime of the executable.**

| Option      | Default            | What it does                      |
| ----------- | ------------------ | --------------------------------- |
| `codexPath` | The bundled binary | A `codex` executable to run       |
| `env`       | `process.env`      | The environment of the executable |

**`createCodexExecutor(options)` builds the executor of one seat.** It takes
`definition`, `codexPath`, and `env`. It also takes `client`, a function that
builds the SDK client. The tests use `client` to replay recorded events.

**The executor always sets `skipGitRepoCheck`.** A room seat runs where the
application puts it, and that place is often no git repository.

## How a room tool reaches Codex

**Codex runs tools as MCP servers that it spawns.** The three room tools
(`say`, `seat`, `unseat`) and the tools of the agent live in the host. A small
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
   socket. The bridge runs the call against the room and returns the result.
5. `close` stops the socket. The server exits when the socket closes.

**Codex spawns the built server.** The package ships
`dist/room-tools-server.mjs` and starts it with `node`. In the source tree
the same path resolves to `src/room-tools-server.ts`, which Node runs by
stripping types. `serverPath` picks the file from the extension of the module
that calls it, and a test covers both cases.

**The config key sets three limits and one mode.**
`startup_timeout_sec` is 30. `tool_timeout_sec` is 600.
`default_tools_approval_mode` is `approve`.

**Approval is set because a headless run cannot answer.** Under
`approvalPolicy: 'never'`, Codex denies an MCP call that needs approval. The
real binary answers every `say` with "MCP tool call requires approval, but
approval policy is never", and the seat answers in plain text that the room
never records. The room tools belong to the seat, so the config approves
them. With `nativeTools: 'codex'`, Codex applies its own policy to its native tools.

## How an activation runs

**One thread serves one activation.** The first pass starts a thread and
sends one prompt: the mechanism, the agent instructions, and the whole view.
The Codex SDK has no system prompt option, so the first prompt carries them.
A later pass sends the delta, the lines that landed since the pass read, as
the next run of the same thread. The `turn.*` events of Codex mark each run.

**A run ends on `turn.completed` or `turn.failed`.** Codex also sends `error`
events for trouble that it survives, such as a reconnect. An `error` event
ends the run only when nothing else does.

**Freshness rests on two events.** Codex sends no echo of the input that it
read. The executor moves `readThrough` on these events:

- **`turn.started`.** The model reads the prompt when a run starts.
  `readThrough` moves to the position of the view or the delta.
- **A missed say.** The room refuses a say because the record moved. The tool
  result carries the missed lines to the model in the same reply, so
  `readThrough` moves to the last of them at once.

A say never commits against a record that the model has not read.

**Codex takes no steer.** The session has no `steer` member. A line that
lands during a run waits. The driver runs a delta pass after the run ends,
and the model reads the line then. The seat reads it late and never
commits over it.

**A cut signals the run.** `abort` signals the run in flight. `close` stops
the socket and the server. A late cut signals no dead process.

## Step mapping

**Each item that Codex reports becomes steps in the trace.** Codex reports an
item as it starts, as it changes, and as it completes. A text item carries the
whole text so far, so the steps hold the growth: one delta for each update,
then a closing step.

| Codex item or event  | Steps                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `agent_message`      | `text` deltas, then a closing `text`                                       |
| `reasoning`          | `thinking` deltas, then a closing `thinking`                               |
| `mcp_tool_call`      | `tool_call` and `tool_result`; a room tool has its own name                |
| `command_execution`  | `tool_call` named `command`; the result holds the output and the exit code |
| `file_change`        | `tool_call` named `file_change`; the result holds the changes              |
| `web_search`         | `tool_call` named `web_search`, with the query                             |
| `turn.completed`     | `usage`                                                                    |
| `todo_list`, `error` | No step                                                                    |

**A failed item marks its result.** A failed command gives the error "The
command failed with exit code N". A failed patch gives "The patch failed".
A failed MCP call gives the message that Codex reported.

**A tool of another server shows with its server.** The step name is
`server__tool`. A room tool shows as `say`, `seat`, or `unseat`, and the
executor reports it as a room event and never as a tool event.

**A completed patch feeds `refs`.** The executor collects the paths of each
completed `file_change`. The next ordinary `say` cites them in `refs`, and
the bridge holds each path once. A ref is an absolute URI with a scheme, so
the executor writes each path as a `file:` URI. The room refuses a bare path.

**The package writes no `approval` step.** Codex answers its own approvals by
its policy and reports none through the SDK.

## Usage

**One `usage` step ends each run.** `turn.completed` reports input, cached,
and output tokens. The activation sums them and reports the total on
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

## Failures

**Codex reports a failed run as text.** The `turn.failed` and `error` events
carry a message and no status code, so the classification reads the text.

| The text names                                      | Result                     |
| --------------------------------------------------- | -------------------------- |
| A quota, a credential, or a permission refusal      | Permanent failure          |
| An HTTP status of 400, 401, 402, 403, 404, 405, 422 | Permanent failure          |
| A full context window or a spent output limit       | A length stop, no failure  |
| Anything else                                       | Transient failure, a retry |

**A fault of the executor is transient.** A lost process, a missing binary,
or a socket error gives a transient failure, and the room tries the
activation again. A stream that ends with no terminal event does the same.
A failure reaches the host as an `error` event before the driver sees it.

## Memory

**`memory: 'activation'` is the default.** Each activation starts a fresh
thread and records no session.

**`memory: 'seat'` resumes one thread for the seat.**

- The executor keeps the thread id from the `thread.started` event.
- The next activation calls `resumeThread(id)`.
- The release of each activation records the id as the session, with the
  harness name `codex`.
- After a restart the id comes from `spec.resume`, which the room reads off
  the journal. The executor ignores a session that another harness recorded.

**A resume that Codex cannot honor starts a fresh thread.** Such a resume fails
before `thread.started`. The executor then starts a fresh thread, runs the
same prompt, and records the new id. A failure after `thread.started` is an
ordinary failure.

**Threads live in the Codex store.** The SDK persists threads under
`~/.codex/sessions`. A host that loses that directory falls back to a fresh
thread. Freshness governs speech in both modes.

## The trust boundary

**A seat has no native tools by default.** `nativeTools: 'none'` gives the
seat the room tools (`say`, `seat`, `unseat`) and the tools of `tools` and
`bundles`. Every seat of a room that uses the default has the same tools.
Files reach the seat only through the tools that the application gives it,
such as the workspace tools.

**Code Mode ignores the sandbox.** This is a fact about Codex 0.155.1.
Code Mode is a JavaScript runtime that the model calls through `exec` and
`wait`. On a read-only sandbox, with no network and a deny permission
profile, its JavaScript still read `/etc/hosts` and listed `/Users` through
`fs`. It could not start a process or reach the network. `sandboxMode` and
permission profiles do not confine it. A feature flag cannot turn it off,
because the model catalog turns it on: `gpt-5.6-luna` has
`tool_mode: 'code_mode_only'`. `gpt-5.5` has no tool mode.

**The default replaces the catalog entry.** A custom catalog overrides the
entry of a model. The executor runs `codex debug models` on the installed
binary once for each binary in the process and patches the entry of the seat
model. It writes the patched catalog to a temporary directory and passes the
path as `model_catalog_json`. The recipe has five parts:

1. **The catalog entry.** `tool_mode`, `apply_patch_tool_type`, and
   `multi_agent_version` are `null`. `input_modalities` is `['text']`.
   `supports_search_tool`, `supports_image_detail_original`, and the three
   `include_*_usage_instructions` flags are `false`. `node_repl_disabled` is
   `true`. `experimental_supported_tools` is empty. This removes Code Mode,
   the patch tool, image input, and the search tool.
2. **The features.** The config sets 31 features to `false`, among them
   `shell_tool`, `unified_exec`, `code_mode`, `code_mode_only`, `apps`,
   `plugins`, `computer_use`, `multi_agent`, and `hooks`. This removes the
   shell and the tools that a feature adds.
3. **The tool switches.** `web_search` is `'disabled'`. `tools.view_image`
   is `false`. `update_plan` and `experimental_request_user_input` are
   disabled.
4. **The bundled REPL.** Codex adds a `node_repl` MCP server. The config
   declares `mcp_servers.node_repl` as disabled, by name, beside the room
   server. Without it the tool list holds `mcp__node_repl.js`.
5. **Defense in depth.** The thread runs on a read-only sandbox, with no
   network, no approval, and an empty temporary directory as its working
   directory. No repository and no host file is the default context.

The temporary directory of each activation holds the patched catalog and the
empty working directory. The executor removes it when the activation closes,
and at process exit.

**A model with no catalog entry does not start.** The activation fails as
permanent. The message names the model and says that `nativeTools: 'none'`
needs a catalog entry. The executor never leaves native tools on by
accident. Use a model that `codex debug models` lists, or set
`nativeTools: 'codex'`.

**`nativeTools: 'codex'` opens the host.** The seat keeps the tools of the
model. A seat with Code Mode reads host files whatever `sandboxMode` says.
`sandboxMode`, `approvalPolicy`, `networkAccessEnabled`, and
`workingDirectory` then set what a command may do, and Code Mode is outside
their reach. Use it only for a seat that may read the host.

**The version pin guards the recipe.** The package pins `@openai/codex-sdk`
0.155.1, which brings `codex` 0.155.1. The feature names and the catalog
fields belong to that version. A newer `codex` can add a native tool that
the recipe does not turn off. Run the live exclusivity test
(`test/live/exclusive.test.ts`) against a new version, and trust the version
only when it passes.

**The environment includes the key by default.** With no `env` on
`codexExecution()`, the binary inherits `process.env`. A command that runs
under `nativeTools: 'codex'` can read `CODEX_API_KEY` from it. Pass an `env`
that leaves the key out to prevent that, and sign in with `codex login`
instead.

**The room tools are approved.** They only call the room, and the room
checks each call.

## Testing

**A real model cannot be scripted, so the executor suite runs live.** Pi and
Claude have a fake model or a fake executable that plays a plan from
`@ambionframework/ambion/conformance`. A fake `codex` proves only that the
adapter agrees with its own guess about the SDK, so the package has none.
The package has no `./testing` entry for that reason.

**The unit tests run on recorded events.** `test/fixtures/` holds event
streams that a real `codex` 0.155.1 produced through the SDK 0.155.1, on the
model `gpt-5.6-luna`. The tests map them to steps, count usage, and report
the changed paths. Pure parts have their own tests: the wire framing, the
room tools, the options, and the failure classification. A replay client
runs the executor on the recorded events to test the memory modes.

**The live tier proves the claims that recorded events cannot.** Each file
holds the smallest room that proves one claim.

| File                          | Claim                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `test/live/loop.test.ts`      | A seat speaks through `say`; no approval error; usage above zero                                                    |
| `test/live/tools.test.ts`     | A command and a file change become steps; the next say cites the path                                               |
| `test/live/exclusive.test.ts` | The default seat has exactly the room tools and its own; it reads no host file; `'codex'` restores the native tools |
| `test/live/steer.test.ts`     | A line sent during a run is held, and the next pass reads it                                                        |
| `test/live/memory.test.ts`    | A resumed thread answers from the first activation; a bogus id falls back                                           |
| `test/live/mixed.test.ts`     | A Pi seat and a Codex seat both speak                                                                               |

**Run the live tier with a key.** Every definition sets the model
`gpt-5.6-luna` and `modelReasoningEffort: 'medium'`. A file skips when
`CODEX_API_KEY` is unset.

```sh
CODEX_API_KEY=... pnpm --filter @ambionframework/codex run test:live
```

The script builds the package first, because Codex spawns the built server.
The mixed file also needs the key of the Pi model (`AMBION_MODEL`, default
`anthropic/claude-sonnet-5`). A live run costs money: run one file with
`pnpm --filter @ambionframework/codex exec vitest run --config
vitest.live.config.ts test/live/loop.test.ts`.

## Troubleshooting

**The seat answers in its final message and nobody hears it.** Codex has its
own final-answer channel. The room hears only `say`. The first prompt of a
thread says so. A seat that still ends with plain text and no `say` shows a
`text` step and no `tool_call` in its trace, and `activation_end` reports
`spoke: false`.

**Every say is denied.** The seat answers in plain text, and the record holds
nothing. The trace shows a `tool_result` with "MCP tool call requires
approval". The config key `default_tools_approval_mode` must be `approve`. A
custom `config` that replaces `mcp_servers` removes it.

**The server does not start.** Codex reports the startup as failed after 30
seconds. Check that `dist/room-tools-server.mjs` exists beside `dist/index.mjs`
and that `node` on the `PATH` of the process is Node 26.4 or newer. Run
`node dist/room-tools-server.mjs /tmp/none.sock` to see its error.

**The Node version is too old.** The package needs Node 26.4 or newer, and Node
strips types from `.ts` files only in the source tree. An older Node fails on
a built package with a syntax or an engine error.

**A thread cannot resume.** The executor starts a fresh thread and the seat
loses what the old thread held. The record still holds every line. Look for a
missing `~/.codex/sessions` directory, a `codex` of another version, or a
different account than the one that started the thread.

**A run fails with a sign-in message.** The failure is permanent, so the room
does not retry. Set `CODEX_API_KEY`, or run `codex login`.

**A native tool shows up after a Codex upgrade.** The seat lists or calls a
tool that is not a room tool and not one of yours. A newer `codex` added a
feature or a catalog field that the recipe does not cover. Run
`test/live/exclusive.test.ts` to see the name. Compare `codex debug models`
and the feature list of the new version with `src/catalog.ts`. Add the
feature or the field, and keep the version pinned until the test passes.
