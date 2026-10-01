# @ambionframework/codex

**Run Ambion agents on the Codex SDK.** `codex()` defines the executor of an
agent. A room with no `execution` runs each Codex seat on the default
execution. `codexExecution()` gives a runtime or a room the same services
with options. The kernel, `@ambionframework/ambion`, imports no model
library. This package holds the Codex SDK and the MCP SDK.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';
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

const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const room = await startRoom({
  name: 'delivery',
  agents: [planner],
});
const visit = await room.visit(priya);
await visit.send({ text: 'Is the plan ready?' });
```

**Install it next to the kernel.** Run `npm install @ambionframework/ambion
@ambionframework/codex`. The package needs Node 22.19 or newer. The Codex SDK
brings the `codex` binary. Sign in with `CODEX_API_KEY` in the environment,
or run `codex login`. A ChatGPT sign-in runs the seat on a ChatGPT Plus or
Pro subscription: leave `CODEX_API_KEY` out. Every seat runs in the Codex
home `home`, `~/.ambion/codex` by default, and links the file `auth.json` of
the host. The `config.toml` and the `AGENTS.md` of `~/.codex` reach no seat.
The binary runs with an allowlist of the variables of the host, the `env`
option laid over it, and a private `HOME`, so no secret and no skill of the
host user reaches a seat. A login in the OS keyring
cannot be shared: use the file store, or run `codex login` with
`CODEX_HOME` set to the seat home.

**Codex owns the loop, and the room owns the record.** One Codex thread
serves each activation. The seat text, which holds the mechanism and the
agent instructions, goes in the client config. The first pass sends the whole
view. A later pass sends the delta.

**Room tools reach Codex through a stdio server.** Codex spawns
`dist/room-tools-server.mjs`. The server forwards each call over a local
socket to the host, where the room runs it. The config sets
`default_tools_approval_mode` to `approve`, because a headless run cannot
answer an approval.

**Freshness rests on `turn.started`.** Codex sends no echo of the input it
read. The executor tells the core that the model read the prompt when a run
starts, and that a tool result reached the model when the tool returns. Codex takes
no steer: a line that lands during a run waits for the next pass.

**Items become steps.** `mcp_tool_call` items become `tool_call` and
`tool_result` steps. `agent_message` and `reasoning` items become `text` and
`thinking` steps. `error` items and `error` events become `notice` steps.
`turn.completed` becomes a `usage` step. Codex reports no cost. An item of
any other type becomes a warning `notice` that names the type.

**A seat keeps its thread for one exchange.** Each release records the
thread id. The next activation of the seat in the same exchange resumes
that thread, and the first activation in a new exchange starts a fresh
one. A resume that Codex cannot honor starts a fresh thread.

**A seat has no native tools, ever.** Files and a shell come only from the
workspace tools, behind the workspace port, so it makes no difference whether
the workspace is in memory, a directory, or a remote workstation. Pass the
tools of a workspace in `bundles`, and the tools that you write in `tools`.
Codex has a JavaScript runtime, Code Mode, that read host files under a
read-only sandbox on 0.155.1. The model catalog turns it on, so no feature
flag can turn it off. The executor patches the catalog entry of the model,
turns off every feature and tool that the config controls, and removes the
skills block. It runs the thread on a read-only sandbox in an empty
directory with no network. A model with no catalog entry fails as
permanent. A default seat produces no config warning on 0.158.0.

**Three MCP helper tools remain.** Codex adds `list_mcp_resources`,
`list_mcp_resource_templates`, and `read_mcp_resource` when an MCP server is
on. They reach only the room tools server, which offers no resource and
answers `Method not found`, so they read nothing. A unit test proves it.

**Pin the version, and run the exclusivity test on an upgrade.** The recipe
belongs to `codex` 0.158.0. The binary tier fails when a default seat
gets a native tool, a skills block, or a config warning. Trust a newer
version only when that tier and `test/live/exclusive.test.ts` pass on it.

**Test on recorded events and a scripted model, and run the executor suite
live.** The unit tests read event streams that a real `codex` recorded. They
also run the real `codex` binary against a local endpoint that plays a script
of model replies. The executor suite runs in the live tier on a real model.
Run it with
`CODEX_API_KEY=... pnpm --filter @ambionframework/codex run test:live`. It
costs money.

The [Codex guide](../../docs/codex.md) holds every option, the step
mapping, the usage count, the failure classification, and troubleshooting.
