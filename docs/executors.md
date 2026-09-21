# Executors

An executor runs one agent's model loop for one activation. The room and the
driver own the record, the lease, and the rules. An executor owns the model
call, the tools it exposes, and the steps it reports. [The
README](../README.md) holds the positioning. This page holds the contract
between the driver and an executor, the step vocabulary, and the way to
write an adapter. [The Pi guide](pi.md) and [the Claude guide](claude.md)
hold what is specific to one adapter.

## The executor contract

**The host configures execution before it starts the room.** An `Execution`
is a value that an executor package builds, such as `piExecution()` from
`@ambionframework/pi`. The runtime gives it the clock, the storage, the call
retry policy, and the transport. It returns a connector. The room supplies
the captured agent definition and receives an execution port. It does not
construct a model runner.

`createRuntime` takes an `execution` for every room of the runtime.
`startRoom` and `resumeRoom` take an `execution` for one room run. An
explicit `execution` wins over every default. A room whose seats run on
more than one family passes `composeExecutions`, which routes each seat on
the `kind` of its executor.

**A room with no `execution` uses the default of each executor kind.** An
executor package calls `registerDefaultExecution(kind, factory)` when the
host loads it. The registry holds functions and stays outside the journal,
the captured definition, and the JSON protocol. The kernel imports no
executor package. The runtime builds the default of a kind once, on the
first seat of that kind, over its own storage, clock, limits, and
transport. A seat of a kind with no default fails at once with a
`no_execution` error, and the failure is permanent. A room with no default
still runs its people and its record. A host that needs custom storage,
transport, or limits passes an `execution`. Cloudflare and other separate
hosts resolve their execution on the host and never read the registry.

**A transport receives room calls and executor dependencies separately.**
`Transport.connect(room, context)` receives a plain `RoomProtocol` facade
with `view`, `commit`, and `lease`. The facade gives no access to room
lifecycle methods. The returned `AgentPort` handles `wake`, `steer`, and
`cut`. `AgentExecutionContext` supplies one captured agent definition, the
room and seat names, the clock, the call retry policy, an executor, a trace
opener, and notifications. Remote hosts resolve their execution
dependencies where the agent runs. Only protocol data crosses RPC.

**`AgentRunner` is the driver.** It owns the lease, its renewal, the wake
queue, and the record window. It knows no model and no provider. For each
activation it opens one `ExecutorSession` and passes the windowed record to
it. A session renders a prompt, runs its own model loop for one pass, and
reports where it left off.

| Member                             | What it does                                                           |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `Executor.open(activation)`        | Opens one session. The activation holds `id`, `room`, `emit`, `trace`. |
| `session.pass(input)`              | Runs one pass. Returns `failed`, and on failure a `cause`.             |
| `session.readThrough`              | The highest position the session has consumed.                         |
| `session.steer?(after, seq, line)` | Takes a line into a live pass. Absent when the family cannot.          |
| `session.shouldRefresh(lastSeq)`   | Says whether the session has work for another pass.                    |
| `session.abort()`                  | Cuts a pass in flight. `cancelled` then stops further passes.          |
| `session.close?()`                 | Frees a held process. The driver calls it once, after the release.     |

**The first pass receives the view. A later pass receives a delta.** The
`view` is the whole windowed record. A `delta` holds the fresh view and
`since`, the position the session had read through. A `PassResult` that sets
`stop: 'length'` reports that the model reached a length limit.

**Freshness bounds correctness. Steering is a capability.** The driver
reads `readThrough` to renew the lease and to release it. A commit that
finds a newer message in the record fails as `missed`, and the seat reads
again. An executor that cannot steer omits `steer`. The next pass rereads
the record, so a dropped steer is not lost. [Durability](durability.md)
states the commit-freshness promise.

**The hosting entry exports the execution protocol.** `Execution`,
`ExecutionConnector`, `ExecutionHost`, `Transport`, `AgentRunner`,
`inProcessTransport`, `composeExecutions`, `registerDefaultExecution`,
`hostingOf`, and `describeExecutor` come from `@ambionframework/ambion/hosting`. The main
entry names none of them. Journal events and projected lease state stay
internal. Participant views omit `sessionId`.

## The prompt the driver renders

**The renderer returns three prompt parts.** `renderActivation` returns
`mechanism`, `agent`, and `context`. Each part depends on one thing, so an
adapter places it where it caches best.

- `mechanism` depends on the kernel version only. It states how a room
  works.
- `agent` depends on the definition and the purpose. It holds the name, the
  speaking policy, the identity, and the instructions. A closing seat reads
  its summary duties here.
- `context` depends on the activation. It holds the clock, the room, the
  roster, the record, and the ask line.

`renderDelta(view, since)` renders the later passes. It marks each message
beyond `since` with the `[new]` prefix, and returns `undefined` when nothing
is new. `renderLine` renders one steered line. `refusal` renders a room
refusal for the model.

**A definition can replace the speaking policy.** The main entry exports
`DEFAULT_GUIDANCE`. An executor takes a `speaking` option that replaces it.
Tool bundle guidance stays in the `guidance` field and follows the policy.

The hosting entry also exports the three room tools, `SAY`, `SEAT`, and
`UNSEAT`, and `summaryToolDescription`. The rendering helpers and the tools
stay pure and stateless.

## The step vocabulary

**A step is one thing an activation did.** The vocabulary has ten kinds,
and every executor family shares it. A step is plain JSON. The trace stamps
each step with `activation`, `pass`, `at`, and `index`. `index` counts from
zero in each pass. The `TraceStep` type is the stamped form. `Step` in
`types.ts` holds the fields of each kind.

| Step          | Recorded by | Meaning                                                                                            |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `pass`        | driver      | A pass begins. `view` is the first pass; `delta` follows a record that moved.                      |
| `thinking`    | executor    | A block of reasoning. `final` closes the block.                                                    |
| `text`        | executor    | A block of model text. `final` closes the block.                                                   |
| `tool_call`   | executor    | A tool starts, with its input.                                                                     |
| `tool_result` | executor    | A tool ends, with its output, or with `error`.                                                     |
| `room`        | driver      | The room answered a commit: `committed`, `unchanged`, `missed`, `refused`, `stale`, or `unknown`.  |
| `steer`       | executor    | A message landed mid-activation. `consumed` says whether the model received it.                    |
| `approval`    | executor    | A tool call needed a decision. `decision` holds the answer. The Claude executor emits it.          |
| `usage`       | executor    | Tokens and cost. Pi writes one for each provider request; Claude writes one for each SDK result.   |
| `end`         | driver      | The activation stops: `stopped`, `length`, or `aborted`. A failure adds its `cause` and `message`. |

## The trace journal

**The trace journal holds one activation.** The driver opens a `TraceSink`
for each activation and passes it to the executor at `open`. The sink writes
to a journal named by the room and the activation, in the `ambion/trace`
namespace of the host storage. A trace that takes no step opens no journal.
Each step has the key `pass:index`, so a repeated activation writes each
step once. The record and the trace never share an entry.

**The trace never gates the activation.** The trace is a second journal that
the room does not read. A failed trace write raises a `trace_error` event.
The activation outcome and the lease do not change. The driver closes the
sink after it releases the lease. The trace is not part of the record or of
the durability promise.

**The sink applies the policy and the limits.** The sink joins the deltas of
a `thinking` or `text` block into one step, so a block is one entry and one
event. `limits.trace.stepsPerPass` caps the steps of one pass, and an `end`
step is always kept. `limits.trace.toolOutputBytes` cuts a tool output that
is larger, and the step keeps the start of it with a note of the size.
The Pi execution applies the limits of the host. The Claude execution
applies the defaults and ignores `limits.trace`.

**A definition sets its trace policy.** `defineAgent({ trace })` takes
`thinking` (`omit`, `summary`, or `full`) and `toolOutput` (`omit` or
`full`). The default is `{ thinking: 'summary', toolOutput: 'full' }`.
`summary` keeps the first 280 characters of each thinking block.

**Each step also arrives live.** The event stream carries a `step` event for
each step the trace writes, in the same order as the journal. A reader
merges the two by `activation`, `pass`, and `index`. In a separated host the
trace lives in the storage of the seat, so a read across objects needs a call
to the seat. `readActivation` reads the trace of one activation; see
[Exchange](exchange.md).

## The harness matrix

**Three executor families ship today.** Pi, the Claude Agent SDK, and the
Codex SDK implement the contract. The Anthropic SDK tool runner is an
anticipated family. No package for it exists yet.

| Family                    | Package                   | Loop owner | Steer during a pass                 | Status      |
| ------------------------- | ------------------------- | ---------- | ----------------------------------- | ----------- |
| Pi agent core             | `@ambionframework/pi`     | Caller     | Yes, through `agent.steer`          | Shipped     |
| Claude Agent SDK          | `@ambionframework/claude` | Harness    | Yes, on the SDK `user` echo         | Shipped     |
| Codex SDK                 | `@ambionframework/codex`  | Harness    | None; the next `run` takes the line | Shipped     |
| Anthropic SDK tool runner | None                      | Caller     | Between turns                       | Anticipated |

The [Pi](pi.md), [Claude](claude.md), and [Codex](codex.md) guides describe the packages.

**A family that cannot steer still passes.** Its `readThrough` advances at
the pass boundary, and the driver holds a steer for the next pass. The
[plan](../planning/next.md) holds the surface comparison of the four
families. What a harness remembers between activations is in
[Trust](trust.md).

## How to write an adapter

An adapter is a package that builds an `Execution` and an executor for one
family. `@ambionframework/claude` is the worked example, and
`@ambionframework/pi` is the second family.

1. **Implement `Executor` and `ExecutorSession`.** `open` takes the
   activation and returns a session. Keep the model loop for one activation
   inside the session.
2. **Render with the shared helpers.** Call `renderActivation` on the first
   pass and `renderDelta` on later passes. Place `mechanism`, `agent`, and
   `context` where the family caches best.
3. **Expose the three room tools.** Bind `say`, `seat`, and `unseat` to one
   activation, in the form the harness needs. The tools of the definition
   join them.
4. **Write the steps you own.** Call the `TraceSink` of the activation for
   `thinking`, `text`, `tool_call`, `tool_result`, `steer`, `approval`, and
   `usage`. The driver writes `pass`, `room`, and `end`.
5. **Declare steering and rest correctness on freshness.** Advance
   `readThrough` when the model has consumed a message, and on nothing
   earlier. The Claude executor advances it on the SDK echo.
6. **Wrap the executor in an `Execution`.** Export a function that defines
   the executor of an agent and a function that gives the host its
   execution. Claude offers `claude()` and `claudeExecution()`. Call
   `registerDefaultExecution` with the kind, so a room with no `execution`
   serves the seats of the family.

```ts
import { defineAgent, startRoom } from '@ambionframework/ambion';
import { claude } from '@ambionframework/claude';

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
});
```

## The conformance suite

**The suite is the acceptance gate for an adapter.**
`@ambionframework/ambion/conformance` exports `executorConformance`. It
plays the driver and the room for one executor, runs the executor through
the real driver over a scripted room, and checks the room calls and the
trace journal. It checks nothing an executor says beyond its neutral plans.

An adapter supplies an `ExecutorHarness`. `open(plan, definition)` builds
the executor for one `ExecutorPlan`, using a fake model or a fake
executable. `can` is an `ExecutorCapabilities` value with `steer`, `usage`,
and `permanentFailure`. The suite drops each case that a false capability
gates.

Two runs exist as evidence. The scripted executor runs the suite in
`packages/ambion/test/executor-conformance.test.ts`. The Claude executor
runs it against a fake Claude Code executable in
`packages/claude/test/executor-conformance.test.ts`, through
`claudeExecutorHarness` from `@ambionframework/claude/testing`. Neither run
needs a key or a network. The Pi executor has no run of the suite.

The Codex executor does not run the suite. A real model cannot follow a
scripted plan, and a fake `codex` proves only that the adapter agrees with
its own guess about the SDK. The Codex package tests its mapping on events
that a real `codex` recorded, and it runs its executor claims in a live
tier. See [Codex](codex.md).
