# @ambionframework/claude

**Run Ambion agents on the Claude Agent SDK.** `claude()` defines the executor
of an agent. `claudeExecution()` gives a runtime or a room the services that
run it. The kernel, `@ambionframework/ambion`, imports no model library. This
package holds the Claude Agent SDK.

```ts
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { claude, claudeExecution } from '@ambionframework/claude';

const reviewer = defineAgent({
  name: 'reviewer',
  identity: 'Reads the plan and names what is missing.',
  executor: claude({
    instructions: 'Speak when the plan lacks evidence.',
    model: 'claude-sonnet-5',
    allowedTools: ['Read'],
    cwd: '/work/plans',
  }),
});

const room = await startRoom({
  name: 'delivery',
  agents: [reviewer],
  execution: claudeExecution(),
});
```

**Pass `execution` to a room or to a runtime.** A room whose seats run on
more than one family passes `composeExecutions({ pi, claude })` from
`@ambionframework/ambion/hosting`. It routes each seat on the `kind` of its
executor.

**One SDK query serves each activation.** The first pass opens the query and
sends the whole view as a user message. A later pass sends the messages that
landed beyond what the model read. The query keeps its transcript for the
activation. The next activation starts a new one.

**Freshness rests on the echo.** The SDK sends each user message back. The
activation advances `readThrough` on that echo and on nothing earlier. A line
that lands during a pass joins the streaming input, so the model takes it
into the pass. A line that lands between passes waits for the next delta.

**Room tools run in process.** One in-process MCP server serves `say`,
`seat`, `unseat`, and the tools of the agent. Each tool call carries the
agent, the room, the activation, and the exchange.

**The room defines the seat.** The query reads no settings source and no
`CLAUDE.md` file. The model sees the room tools, the tools of the agent, and
the built-in tools that `allowedTools` names.

**Policy passes through `claude()`.** The options are `permissionMode`,
`allowedTools`, `disallowedTools`, `canUseTool`, `maxBudgetUsd`, `effort`,
`cwd`, and `additionalDirectories`. A permission request that reaches
`canUseTool` becomes an `approval` step in the trace, with the answer. With
no `canUseTool`, the executor denies each request.

**Test with a fake executable.** `@ambionframework/claude/testing` exports
`claudeExecutorHarness`. It runs the executor suite of
`@ambionframework/ambion/conformance` against a fake Claude Code executable
that the SDK spawns through `pathToClaudeCodeExecutable`. The suite needs no
key and no network.

**Not yet built.** `memory: 'seat'`, which resumes one SDK session for each
seat, is planned in `planning/next.md`.
