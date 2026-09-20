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
limit, an activation reads the whole record. The seat runs `estimateTokens`,
so it never crosses the wire.

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

**A ref is one absolute URI that a message cites.** A ref has a scheme, at
most 2048 characters, and no whitespace. A message carries at most 16 refs
without duplicates. The room stores the list in order, omits an empty list,
and never reads behind a ref. The `say` tool trims each ref and drops blank
ones. A direct `visit.send` keeps refs exactly and refuses a bad one.

**The room owns the `ambion` scheme.** `roomUri(name)` gives
`ambion://room/<name>`. `exchangeUri(name, from)` gives
`ambion://room/<name>/exchange/<from>`. `parseRoomUri` reads only these
canonical forms. The room refuses an `ambion:` ref that is not canonical. The
prompt states the room URI and the URI of the open or covered exchange. An
agent reads numbered positions, so it cannot build the URI of an older
exchange. A workspace path is not a ref. Cite a file with a `file:` URI or
another absolute URI that the application chooses.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

## Execution boundary

This section moves to `executors.md` in phase 7 step 4. That page does not
exist yet.

**The host configures execution before starting the room.** A connector captures
the model call, model resolver, transcript storage, clock, and call retry policy.
The room supplies the captured agent definition and receives an execution port.
It does not construct a model runner or choose execution services.

`startRoom` and `resumeRoom` supply this composition by default. Their `stream`
override applies to one room run. Other rooms retain their own definitions and
model calls, including when they use the same agent names.

**A transport receives room calls and executor dependencies separately.**
`Transport.connect(room, context)` receives a plain `RoomProtocol` facade with
`view`, `commit`, and `lease`. It cannot reach room lifecycle methods through
that facade. The returned `AgentPort` handles `wake`, `steer`, and `cut`.

`AgentExecutionContext` supplies one captured agent definition, the room and seat names,
clock, call retry policy, an executor, and notifications. The in-process
`AgentRunner` uses these values directly. Remote hosts resolve their
execution dependencies where the agent runs. Only protocol data crosses RPC.

**`AgentRunner` is the driver.** It owns the lease, its renewal, the wake
queue, and the record window. It knows no model and no provider. For each
activation it opens one `ExecutorSession` from `AgentExecutionContext.executor` and
passes the windowed record to it. A session renders a prompt, runs its own
model loop for one pass, and reports where it left off. Pi is the only
executor Ambion ships today: `createPiExecutor` builds it from the model
call, the model resolver, and transcript storage that `createExecutionServices`
supplies. Both are available from `/hosting` for remote hosts.

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
Audit consumers import `seatSessionId` from `/hosting` and supply the room
and agent names.
