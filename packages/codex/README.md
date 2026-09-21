# @ambionframework/codex

**Run Ambion agents on the Codex SDK.** `codex()` defines the executor of an
agent. `codexExecution()` gives a runtime or a room the services that run it.
The kernel, `@ambionframework/ambion`, imports no model library. This package
holds the Codex SDK and the MCP SDK.

```ts
import { defineAgent, defineHuman, startRoom } from '@ambionframework/ambion';
import { codex, codexExecution } from '@ambionframework/codex';

const planner = defineAgent({
  name: 'planner',
  identity: 'Reads the plan and names what is missing.',
  executor: codex({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'gpt-5.6-luna',
    modelReasoningEffort: 'medium',
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
    workingDirectory: '/work/plans',
  }),
});

const priya = defineHuman({ name: 'priya', identity: 'Project manager.' });

const room = await startRoom({
  name: 'delivery',
  agents: [planner],
  execution: codexExecution(),
});
const visit = await room.visit(priya);
await visit.send({ text: 'Is the plan ready?' });
```

**Install it next to the kernel.** Run `npm install @ambionframework/ambion
@ambionframework/codex`. The package needs Node 26.4 or newer. The Codex SDK
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
ordinary say cites the paths of a completed `file_change` in `refs`, as `file:` URIs.

**Choose the memory of the seat.** `memory: 'activation'` is the default. It
opens one thread for each activation. `memory: 'seat'` resumes one thread
for the seat and records its id with each release. A resume that Codex cannot
honor starts a fresh thread.

**Trust what Codex runs.** Codex runs on the host, under `sandboxMode`,
`approvalPolicy`, `networkAccessEnabled`, and `workingDirectory`. The
environment of the process, key included, reaches the binary unless you pass
`env` to `codexExecution()`.

**Test on recorded events, and run the executor suite live.** The unit tests
read event streams that a real `codex` recorded. A real model cannot be
scripted, so the executor suite runs in the live tier. Run it with
`CODEX_API_KEY=... pnpm --filter @ambionframework/codex run test:live`. It
costs money.

The [Codex guide](../../docs/codex.md) holds every option, the step
mapping, the usage count, the failure classification, and troubleshooting.
