# The agent

**An agent owns its instructions, model, tools, and domain behavior.** The
room owns the journal, membership, presence, execution authority, and exchange
rules. `agents` supplies every executable definition for one room run.

The [documentation index](README.md) links the other contracts. The
[plan](../planning/next.md) defines the scope and records the work that
remains.

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
`limits.context.messages` under History and limits. The seat runs
`estimateTokens`, so it never crosses the wire. `trace` sets what the trace
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
`ambion://room/<name>`. `exchangeUri(name, from)` gives
`ambion://room/<name>/exchange/<from>`. `parseRoomUri` reads only these
canonical forms. The room refuses an `ambion:` ref that is not canonical. The
prompt states the room URI and the URI of the open or covered exchange. An
agent reads numbered positions, so it cannot build the URI of an older
exchange. A workspace path is not a ref. Cite a file with a `file:` URI or
another absolute URI that the application chooses.

**A refusal is typed.** The room throws `AmbionError`. Its `code` is one of
the closed set in `errors.ts`; its message is for a person.

## Rooms and membership

`startRoom` writes a version 2 composition and starts the room. `seats` names
initial members and their attention. If `seats` is omitted, every defined
agent starts as a member with `broadcast` attention. An empty map starts all
defined agents in the reserve.

```ts
const room = await startRoom({
  name: 'weekly',
  goal: 'Prepare the weekly report.',
  agents: [researcher, editor],
  seats: { researcher: 'broadcast', editor: 'none' },
  summary: 'editor',
});
```

`room.seat(name)` adds a defined agent to membership. `room.unseat(name)`
removes a member and returns the definition to the reserve. A live activation
may call the same operations for another agent or itself, unless the target
seat is fixed: the summary writer's seat is fixed by default, and only the
host can unseat it. The room refuses an unknown name and a name that belongs
to a human visitor.

See [Roster](roster.md) for membership, attention, and duplicate-operation
semantics. Attention selects work; it does not authorize contributions. The
room checks execution authority and consumed context at the commit boundary.

## People and exchanges

`defineHuman` supplies a name, identity, and optional reading preferences.
`room.visit(human)` records arrival and returns a visit. `visit.send` records a
question or delivery and returns an exchange handle. `visit.leave` records the
departure.

One exchange starts with a person's question and ends when the room has no
remaining discussion work. The room records its fixed source range. Later
messages do not change that range. `exchange.waitForClose()` returns the source
discussion for human review. `exchange.waitForSummary()` returns the optional
summary result. See [exchange.md](exchange.md), [presence.md](presence.md), and
[summary.md](summary.md).

## Journal authority

**The journal is the authority.** A room derives membership, presence,
activations, leases, routing, exchange boundaries, and completion by folding
recorded entries. A host can resume the same behavior by replaying the journal.

The journal records messages, membership changes, leases, exchange closes,
composition, cancellation boundaries, and run fences. It also records the
activation id that authorized an agent contribution. The room stamps
provenance fields; callers cannot claim another participant's name.

The room serializes accepted writes. Agents can reason concurrently. A speech
commit carries `readThrough`, the highest message position its activation read.
The room refuses a stale commit and returns the missed messages. Lease renewal
extends execution time and does not acknowledge new context.

An agent may finish without calling `say`. The room records the lease outcome.
Model failure, retry exhaustion, deliberate silence, and an accepted message
remain distinct outcomes.

## Value ownership

**Room reads return detached values.** Messages, participant lists, reads,
exchange discussions, and summary responses belong to their caller. Changing
these values cannot change the room's journal, projection, or later reads.
Nested routing lists and summary ranges follow the same rule.

**Each listener receives its own notification value.** Collaboration facts
inside that notification are detached from the room and other listeners.
Error notifications retain the original `Error` object, including its cause
and provider-specific fields. Errors describe execution; they are not room facts.
An execution event names its activation.

**In-process transports have the same ownership boundary as remote calls.**
The room captures commit and lease requests before awaiting work. Results and
steering messages carry detached collaboration facts. A caller's later edits
cannot change the submitted request or another executor's context.

## Activation and context

An activation is a bounded execution with one room grant. Its purpose is either
to answer a message or to write a closing summary. The room derives purpose
from the activation id and current journal state. A caller cannot construct
authority by changing fields in a request.

An ordinary activation reads the goal, participants, reserve identities, and
the messages allowed by its context boundary. A summary activation reads
every message through its fixed exchange, plus its recipient and that
person's preferences. It cannot change the recipient or the exchange it
covers.

Active agents receive new eligible context between provider requests. A steer
does not acknowledge that context. The next contribution must report what the
activation consumed.

## Execution boundary

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
clock, call retry policy, an executor, a trace opener, and notifications. The in-process
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

## Steps and the trace

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

## History and limits

Composition entries use version 2. The room rejects legacy compositions and
does not reinterpret old assistant definitions or opening activation ids.
Start a new journal or migrate the history outside Ambion before resuming it.

The journal retains complete history. An agent that sets `activationTokenLimit`
reads a bounded record. The seat pages the record from the tail through the seat
call `view(activation, range)`, and it keeps the newest part that fits the
limit, plus the open exchange whole. An older exchange falls out of context; its
summary stands for it when one exists. An agent with no limit reads the whole
record the room serves. The record keeps every message for human review
either way.

`limits.context.messages` caps the record at the room, for every seat and
for every executor. The room serves the newest `messages` entries of the
record an activation may read. The floor moves past a summarised range it
would split. The open exchange stays whole, so a cap smaller than the open
exchange serves the exchange in full. The view holds up to `messages` entries
plus the open exchange. The cap counts messages; it does not count
bytes. The default is unbounded. A seat with `activationTokenLimit`
windows further, inside what the room serves.

When a view holds less than the whole record, `context.omitted` counts the
messages below the first one served, and the rendered record opens with one
line: `── N earlier messages not shown ──`. The line shows for summarised and
unsummarised history alike. The room does not record the cap. A room resumed
under another cap serves a different view of the same record.

Ambion does not promise bounded replay. The record window bounds model input,
not the journal fold. Domain tools can act before a contribution commits; room
freshness does not make external effects transactional. Hosts own credentials,
process lifetime, and recovery.
