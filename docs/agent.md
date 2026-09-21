# Definitions and tools

**An agent owns its instructions, model, tools, and domain behavior.** The
room owns the journal, membership, presence, execution authority, and exchange
rules. `agents` supplies every executable definition for one room run.

This page is not the entry point. Read [The room](room.md) first for the
overview, the glossary, and the room-wide mechanisms. The
[documentation index](README.md) links the other contracts.

## Definitions

Define each agent once and pass the definitions in `agents`.

```ts
const researcher = defineAgent({
  name: 'researcher',
  identity: 'Checks evidence and states uncertainty.',
  executor: pi({
    instructions: 'Use the supplied evidence. Speak when it changes the answer.',
    model: 'anthropic/claude-sonnet-5',
    tools: [lookup],
  }),
});

const room = await startRoom({
  name: 'delivery',
  agents: [researcher, editor],
  summary: 'editor',
});
```

`name` identifies the agent inside the room and on the journal. `identity` is
public roster text. `executor` names the loop the agent runs on and its
configuration. `pi` is the only executor today. Its `instructions` are private
model guidance. `model` names a Pi provider model. `tools` and `bundles`
supply the agent's domain tools. `activationTokenLimit` bounds the record one
activation reads, and `estimateTokens` counts tokens against it. Without a
limit, an activation reads the whole record the room serves. See
`limits.context.messages` in [History and limits](room.md#history-and-limits).
The seat runs `estimateTokens`, so it never crosses the wire. `trace` sets what the trace
keeps of the agent's work; see [Steps and the trace](#steps-and-the-trace).

`summary` is an optional name from `agents`. It assigns closing work to that
ordinary agent. `assistant` accepts an ordinary agent definition and supplies
its registration, broadcast seat, and summary assignment. The optional
`@ambionframework/assistant` package supplies a default definition factory.
The shorthand introduces no separate role or tool set. See
[Default assistant](assistant.md) for configuration and behavior.

Definitions are values, captured for one run. On resume, the host supplies
executable definitions for every recorded agent name. The new run may use
updated definitions and add definitions to the reserve; live runs keep their
captured definitions.

## Tools

`defineTool` captures a TypeBox schema and validates parameters before calling
the typed function.

```ts
const lookup = defineTool({
  name: 'lookup_order',
  description: 'Fetch an order by id.',
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, ctx) => `Order ${id}: ${await orders.status(id)}`,
});
```

Every ordinary activation receives `say`, `seat`, and `unseat`, plus the tools
from its definition. A closing activation receives only `say`. `say` accepts
`{ text, to?, refs? }`. The room stamps the author, activation, time, and routing
facts. `seat` and `unseat` accept an agent name. The room validates operations
at the commit boundary.

**A tool learns where it ran from `ctx`.** `ctx.room` names the room and
`ctx.activation` holds the id that every event and message of the
activation carries. `ctx.exchange` holds the `owner` and `from` of the
exchange that was open when the activation read the record. The value is
provenance and grants no authority. A tool that needs the current state of
the room reads the room. All three are absent for a call made outside a
room.

**Spoken contributions require nonblank text.** The room refuses empty or
whitespace-only human messages, agent messages, and summaries before writing.
A refusal does not reserve the request key. Direct calls preserve accepted
text exactly; `say` trims its input. An agent can finish silently without `say`.

**A message has a size limit.** `limits.message.bytes` sets the most UTF-8
bytes one human message, agent message, or summary text carries. The default
is unbounded. The room refuses a longer text with the code `message_too_large`
before it writes. An agent reads the refusal as a tool error and can say a
shorter text. The limit counts `text` only.

**A ref is one absolute URI that a message cites.** A ref has a scheme, at
most 2048 characters, and no whitespace. A message carries at most 16 refs
without duplicates. The room stores the list in order, omits an empty list,
and never reads behind a ref. The `say` tool trims each ref and drops blank
ones. A direct `visit.send` keeps refs exactly and refuses a bad one.

**The room owns the `ambion` scheme.** `roomUri(name)` gives
`ambion://room/<name>`. `messageUri(name, seq)` gives
`ambion://room/<name>/message/<seq>`. `parseRoomUri` reads only these
canonical forms. The room refuses an `ambion:` ref that is not canonical. The
prompt states the room URI and the URI of the message that opened the
current exchange. The seq in a message URI is the same `seq` a workspace
mirror writes for that message, so a reader can find the cited line in
`/rooms/<name>/messages.jsonl` (see
[the mirror](workspace.md#mirror-a-rooms-messages)). A workspace path is not
a ref. Cite a file with a `file:` URI or another absolute URI that the
application chooses. [Resources](resources.md) states how a resource change
is cited.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

## Execution boundary

This section moves to `executors.md` in phase 7 step 3. That page does not
exist yet.

**The host configures execution before starting the room.** An `Execution`
is a value that an executor package builds, such as `piExecution()` from
`@ambionframework/pi`. The runtime gives it the clock, the storage, the call
retry policy, and the transport. It returns a connector. The room supplies
the captured agent definition and receives an execution port. It does not
construct a model runner or choose execution services.

`createRuntime` takes an `execution` for every room of the runtime. `startRoom`
and `resumeRoom` take an `execution` for one room run. Other rooms retain
their own definitions and model calls, including when they use the same agent
names. A room with no `execution` still runs its people and its record. Each
seat that the room wakes fails at once with a `no_execution` error, and the
failure is permanent.

**A transport receives room calls and executor dependencies separately.**
`Transport.connect(room, context)` receives a plain `RoomProtocol` facade with
`view`, `commit`, and `lease`. It cannot reach room lifecycle methods through
that facade. The returned `AgentPort` handles `wake`, `steer`, and `cut`.

`AgentExecutionContext` supplies one captured agent definition, the room and seat names,
clock, call retry policy, an executor, a trace opener, and notifications. The in-process
`AgentRunner` uses these values directly. Remote hosts resolve their
execution dependencies where the agent runs. Only protocol data crosses RPC.

**`AgentRunner` is the driver.** It owns the lease, its renewal, the wake
queue, and the record window. It knows no model and no provider. For each
activation it opens one `ExecutorSession` from `AgentExecutionContext.executor` and
passes the windowed record to it. A session renders a prompt, runs its own
model loop for one pass, and reports where it left off. The first pass of an
activation receives the whole view. Each later pass receives a `delta`: the
fresh view and `since`, the position the session had read through.

**The renderer returns three prompt parts.** `renderActivation` returns
`mechanism`, `agent`, and `context`. Each part depends on one thing, so an
adapter places it where it caches best.

- `mechanism` depends on the kernel version only. It states how a room works.
- `agent` depends on the definition and the purpose. It holds the name,
  the speaking policy, the identity, and the instructions. A closing seat
  reads its summary duties here.
- `context` depends on the activation. It holds the clock, the room, the
  roster, the record, and the ask line.

The Pi executor sends `mechanism` and `agent` as the system prompt, and
`context` as the first user message. `renderDelta(view, since)` renders the
later passes: each message beyond `since` with the `[new]` prefix, or
`undefined` when nothing is new.

**A definition can replace the speaking policy.** The kernel exports
`DEFAULT_GUIDANCE`. An executor takes a `speaking` option that replaces it.
Tool bundle guidance stays in the `guidance` field and follows the policy.

Pi is the only executor Ambion ships today. It lives in
`@ambionframework/pi`, and the kernel imports no model library.
`createPiExecutor` builds it from the model call, the model resolver, and the
transcript storage that `createExecutionServices` supplies. Both are
available from that package for remote hosts. The Pi executor builds one Pi
`Agent` on the first pass and keeps it. A later pass prompts that agent with
the messages that landed beyond `readThrough`.

The runtime keeps lifecycle control separately. `runningRoom(runtime, name)`
returns the same restricted room-call surface. Room decisions use the journal
projection and an explicit clock value. They do not require model services.

**The hosting entry exports the execution protocol.** It includes requests,
responses, activation context, and delivery operations. Journal events and
projected lease state stay internal. Protocol data and stored events retain
their existing JSON shapes.

Hosts use room reads and exchange handles for collaboration history.
Executors use `ActivationView`, `CommitResult`, and `LeaseResponse`.
`EndReason` is part of lease requests. Participant views omit `sessionId`.
Audit consumers import `seatSessionId` from `@ambionframework/pi` and supply the room
and agent names.

## Steps and the trace

This section moves to `executors.md` in phase 7 step 3. That page does not
exist yet.

**A step is one thing an activation did.** The step vocabulary has ten
kinds, and every executor family shares it: `pass`, `thinking`, `text`,
`tool_call`, `tool_result`, `room`, `steer`, `approval`, `usage`, and
`end`. A step is plain JSON. The trace stamps each step with `activation`,
`pass`, `at`, and `index`. `index` counts from zero in each pass. The
`TraceStep` type is the stamped form.

| Step          | Recorded by | Meaning                                                                                            |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `pass`        | driver      | A pass begins. `view` is the first pass; `delta` follows a record that moved.                      |
| `thinking`    | executor    | A block of reasoning. `final` closes the block.                                                    |
| `text`        | executor    | A block of model text. `final` closes the block.                                                   |
| `tool_call`   | executor    | A tool starts, with its input.                                                                     |
| `tool_result` | executor    | A tool ends, with its output, or with `error`.                                                     |
| `room`        | driver      | The room answered a commit: `committed`, `unchanged`, `missed`, `refused`, `stale`, or `unknown`.  |
| `steer`       | executor    | A message landed mid-activation. `consumed` says whether the model received it.                    |
| `approval`    | executor    | A tool call waits for a decision. No executor emits it yet.                                        |
| `usage`       | executor    | Tokens and cost of one provider request.                                                           |
| `end`         | driver      | The activation stops: `stopped`, `length`, or `aborted`. A failure adds its `cause` and `message`. |

**The trace journal holds one activation.** The driver opens a
`TraceSink` for each activation and passes it to the executor at `open`.
The sink writes to a journal named by the room and the activation, in the
`ambion/trace` namespace of the host storage. A trace that takes no step
opens no journal. Each step has the key `pass:index`, so a repeated
activation writes each step once. The record and the trace never share an
entry.

**The trace never gates the activation.** A failed trace write raises a
`trace_error` event. The activation outcome and the lease do not change. The
driver closes the sink after it releases the lease.

**The sink applies the policy and the limits.** The sink joins the deltas of
a `thinking` or `text` block into one step, so a block is one entry and one
event. `limits.trace.stepsPerPass` caps the steps of one pass, and an `end`
step is always kept. `limits.trace.toolOutputBytes` cuts a tool output that
is larger, and the step keeps the start of it with a note of the size.

**A definition sets its trace policy.** `defineAgent({ trace })` takes
`thinking` (`omit`, `summary`, or `full`) and `toolOutput` (`omit` or
`full`). The default is `{ thinking: 'summary', toolOutput: 'full' }`.
`summary` keeps the first 280 characters of each thinking block.

**Each step also arrives live.** The event stream carries a `step` event
for each step the trace writes, in the same order as the journal. A reader
merges the two by `activation`, `pass`, and `index`. In a separated host the
trace lives in the storage of the seat, so a read across objects needs a call
to the seat. The public read of a trace (`readActivation`) is pending release
work and is not part of this contract yet.
