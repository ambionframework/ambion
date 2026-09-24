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
or run `codex login`.

**Codex owns the loop, and the room owns the record.** One Codex thread
serves each activation. The first pass sends the mechanism, the agent
instructions, and the whole view. A later pass sends the delta.

**Room tools reach Codex through a stdio server.** Codex spawns
`dist/room-tools-server.mjs`. The server forwards each call over a local
socket to the host, where the room runs it. The config sets
`default_tools_approval_mode` to `approve`, because a headless run cannot
answer an approval.

**Freshness rests on `turn.started`.** Codex sends no echo of the input it
read. `readThrough` moves when a run starts, and on a missed say. Codex takes
no steer: a line that lands during a run waits for the next pass.

**Items become steps.** `command_execution`, `file_change`, `mcp_tool_call`,
and `web_search` items become `tool_call` and `tool_result` steps.
`agent_message` and `reasoning` items become `text` and `thinking` steps.
`turn.completed` becomes a `usage` step. Codex reports no cost. The next
ordinary say cites the paths of a completed `file_change` in `refs`, as
`file:` URIs.

**A seat keeps its thread for one exchange.** Each release records the
thread id. The next activation of the seat in the same exchange resumes
that thread, and the first activation in a new exchange starts a fresh
one. A resume that Codex cannot honor starts a fresh thread.

**A seat has no native tools by default.** `nativeTools: 'none'` gives the
seat the room tools and the tools that you pass in `tools`. Codex 0.155.1
has a JavaScript runtime, Code Mode, that reads host files under a read-only
sandbox. The model catalog turns it on, so no feature flag can turn it off.
The executor patches the catalog entry of the model, turns off every feature
and tool that the config controls, and runs the thread on a read-only
sandbox in an empty directory. A model with no catalog entry fails as
permanent.

**Three MCP helper tools remain.** Codex adds `list_mcp_resources`,
`list_mcp_resource_templates`, and `read_mcp_resource` when an MCP server is
on. They reach only the room tools server, which offers no resource and
answers `Method not found`, so they read nothing. A unit test proves it.

**`nativeTools: 'codex'` opens the host.** The seat keeps the tools of the
model, and a seat with Code Mode reads host files whatever `sandboxMode`
says. Codex runs its commands with no sandbox of its own unless you set
`sandboxMode`. The policy options apply only under `'codex'`: `sandboxMode`,
`approvalPolicy`, `networkAccessEnabled`, and `workingDirectory`. The
environment of the process, key included, reaches the binary unless you pass
`env` to `codexExecution()`.

**Pin the version, and run the exclusivity test on an upgrade.** The recipe
belongs to `codex` 0.155.1. Trust a newer version only when
`test/live/exclusive.test.ts` passes on it.

**Test on recorded events, and run the executor suite live.** The unit tests
read event streams that a real `codex` recorded. A real model cannot be
scripted, so the executor suite runs in the live tier. Run it with
`CODEX_API_KEY=... pnpm --filter @ambionframework/codex run test:live`. It
costs money.

The [Codex guide](../../docs/codex.md) holds every option, the step
mapping, the usage count, the failure classification, and troubleshooting.
