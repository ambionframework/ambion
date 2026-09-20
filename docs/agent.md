# The agent

**An agent owns its instructions, model, tools, and domain behavior.** The
room owns the journal, membership, presence, execution authority, and exchange
rules. The agent catalog supplies every executable definition for one room run.

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
captured catalog.

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
`{ text, to? }`. The room stamps the author, activation, time, and routing
facts. `seat` and `unseat` accept an agent name. The room validates operations
at the commit boundary.

**Spoken contributions require nonblank text.** The room refuses empty or
whitespace-only human messages, agent messages, and summaries before writing.
A refusal does not reserve the request key. Direct calls preserve accepted
text exactly; `say` trims its input. An agent can finish silently without `say`.

## Rooms and membership

`startRoom` writes a version 2 composition and starts the room. `seats` names
initial members and their attention. If `seats` is omitted, every catalog
agent starts as a member with `broadcast` attention. An empty map starts all
catalog agents in the reserve.

```ts
const room = await startRoom({
  name: 'weekly',
  goal: 'Prepare the weekly report.',
  agents: [researcher, editor],
  seats: { researcher: 'broadcast' },
  summary: 'editor',
});
```

`room.seat(name)` adds a catalog agent to membership. `room.unseat(name)`
removes a member and returns the definition to the reserve. A live activation
may call the same operations for another agent or itself. The room refuses an
unknown name and a name that belongs to a human visitor.

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
activation id that authorized an agent contribution. The room stamps provenance fields; callers cannot claim
another participant's name.

The room serializes accepted writes. Agents can reason concurrently. A speech
commit carries `readThrough`, the highest message position its activation read.
The room refuses a stale commit and returns the missed messages. Lease renewal
extends execution time and does not acknowledge new context.

An agent may finish without calling `say`. The room records the lease outcome.
Model failure, retry exhaustion, deliberate silence, and an accepted message
remain distinct outcomes.

## Value ownership

**Room reads return detached values.** Messages, participant lists, snapshots,
exchange discussions, and summary responses belong to their caller. Changing
these values cannot change the room's journal, projection, or later reads.
Nested routing lists and summary ranges follow the same rule.

**Each listener receives its own notification value.** Collaboration facts
inside that notification are detached from the room and other listeners.
Error notifications retain the original `Error` object, including its cause
and provider-specific fields. Errors describe execution; they are not room facts.

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

`startRoom` and `resumeRoom` supply this composition by default. Their `streamFn`
override applies to one room run. Other rooms retain their own definitions and
model calls, including when they use the same agent names.

**A transport receives room calls and executor dependencies separately.**
`Transport.connect(room, context)` receives a plain `SeatRoom` facade with
`view`, `commit`, and `lease`. It cannot reach room lifecycle methods through
that facade. The returned `SeatPort` handles `wake`, `steer`, and `cut`.

`SeatContext` supplies one captured agent definition, the room and seat names,
clock, call retry policy, model services, transcript storage, and notifications.
The in-process executor uses these values directly. Remote hosts resolve their
execution dependencies where the agent runs. Only protocol data crosses RPC.

`AgentRunner` executes activations through those three room calls.
`createExecutionServices` supplies its model and transcript services without
creating a room runtime. Both are available from `/transport` for remote hosts.

The runtime keeps lifecycle control separately. `runningRoom(runtime, name)`
returns the same restricted room-call surface. Room decisions use the journal
projection and an explicit clock value. They do not require model services.

**The transport entry exports the execution protocol.** It includes requests,
responses, activation context, and delivery operations. Journal events and
projected lease state stay internal. Protocol data and stored events retain
their existing JSON shapes.

Hosts use room reads and exchange handles for collaboration history.
Executors use `ActivationView`, `CommitResult`, and `LeaseResponse`.
`EndReason` is part of lease requests. Participant views omit `sessionId`.
Audit consumers import `seatSessionId` from `/transport` and supply the room
and agent names.

## History and limits

Composition entries use version 2. The room rejects legacy compositions and
does not reinterpret old assistant definitions or opening activation ids.
Start a new journal or migrate the history outside Ambion before resuming it.

The journal retains complete history. An agent that sets `activationTokenLimit`
reads a bounded record. The seat pages the record from the tail through the seat
call `view(activation, range)`, and it keeps the newest part that fits the
limit, plus the open exchange whole. An older exchange falls out of context; its
summary stands for it when one exists. An agent with no limit reads the whole
record. The record keeps every message for human review either way.

Ambion does not promise bounded replay. The record window bounds model input,
not the journal fold. Domain tools can act before a contribution commits; room
freshness does not make external effects transactional. Hosts own credentials,
process lifetime, and recovery.
