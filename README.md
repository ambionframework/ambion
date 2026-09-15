# Ambion

**Build applications as independently owned agents collaborating behind one
human-facing assistant.**

[ambionframework.com](https://ambionframework.com) · [worked demos](demos) ·
[design contracts](docs)

Ambion is for applications assembled from multiple domain agents: one for
scheduling, one for inventory, one for compliance. Each agent keeps its own
context, model, tools, workspace, and team. One assistant owns the
human-facing conversation, selects specialists from a host-defined reserve,
and consolidates their work.

Routing a prompt is not the hard problem. Collaboration is: agents and people
must stay ordered, informed, and accountable, without one context holding
every domain or a person reading a swarm transcript. Ambion provides that
collaboration layer: a shared record, durable seats, attention-based routing,
optimistic concurrency, exchanges, and summaries.

![Collaborating agents working within an exchange: a question opens a bounded sequence on the shared record, agents contribute or stay silent, new messages steer active work, and quiet closes the exchange before optional assistant synthesis.](docs/assets/ambion-exchange.svg)

## The architectural bet

**The agent is the modularity boundary.** A context window stops being a
useful module as unrelated domains accumulate inside it: every new
instruction, tool, and piece of state can change the behaviour of everything
already there. A separately owned agent keeps that failure domain contained.

Ambion keeps domains separate and makes collaboration explicit:

- A scheduling agent changes without retesting a materials agent's prompt.
- Each agent keeps its own model session, tools, and workspace authority.
- Specialists stay in reserve until a question needs them.
- The assistant stays the stable interface as the agents behind it change.
- The person reads one coherent result.

The application grows by adding coherent, independently owned agents.
Collaboration across agents and humans is the key infrastructure problem; the
rest of Ambion follows from taking it seriously.

## Key technical decisions

### 1. The record is the source of truth

Speech, arrivals, departures, seating changes, and summaries are all ordered
messages. [`Journal`](packages/journal/src/journal.ts) serializes writes,
assigns monotonic sequence numbers, and persists each message before it is
exposed; idempotency keys make retries safe. Presence is data: it takes part
in ordering, replay, and routing.

### 2. Conversation uses optimistic concurrency

Ordinary speech carries `readThrough`, the last sequence the activation has
seen. If the record advanced, the room refuses the draft and
returns the missed messages, and the activation rebuilds from a fresh room
view.

The commit boundary prevents speech over unread context. Summaries use the
fixed range of a closed exchange, so later messages do not invalidate them.

### 3. Silence is a result

A normal activation receives the `say` tool. Calling it appends a message;
finishing without calling it appends nothing. The runtime never manufactures
an empty acknowledgement. This makes it cheap to wake every plausibly
relevant agent and let each decide whether it has something to add.

### 4. Attention is not activity

A seat is `active` or `idle` based on whether it is running. It also holds
one point on an attention scale:

```text
none < named < broadcast < presence
```

The scale sets the widest event that wakes the seat: a named message always
reaches its addressee; wider seats also hear room speech, then presence
changes. This keeps lifecycle state separate from routing policy. See
[`seat.ts`](packages/ambion/src/seat/seat.ts).

### 5. An activation can be steered without breaking a provider turn

Messages that arrive during a provider request queue as steers and inject
after the request completes; they never restart work mid-turn. When the
journal has moved past what the activation read, the activation rebuilds
against a fresh room view. Explicit `readThrough` progress records which
context entered a provider request. Lease renewals extend liveness without
inferring that new context was read. See
[`activation.ts`](packages/ambion/src/seat/activation.ts).

### 6. Quiescence defines an exchange

A human question opens an exchange. When the participating seats stop and no
work remains, the room closes it. The exchange stores only its owner and
sequence range; its contents stay derivable from the journal.

Quiescence is the semantic boundary: pending wakes and claimed leases
together determine liveness, so no coordinator predicts the last word and no
activation counter can drift from reality. See
[`exchange.ts`](packages/ambion/src/room/exchange.ts) and
[`lease.ts`](packages/ambion/src/room/lease.ts).

### 7. The assistant owns synthesis for the person

The assistant is the conversational interface: an ordinary seat with its own
model session and activation history. The room designates it through the
`assistant` option. Its policy grants one tool for each exchange event: `seat`, to compose a roster
from agents the host placed in reserve, and `summarise`, after an exchange
closes. It holds no general `say` tool and no general-purpose authority.

Seating a specialist is itself an auditable message. When several agent
messages need consolidation, the summary names the exact sequence range it
covers, so agent contexts and the human-facing view can share it. The record
stays intact; only its rendered views compact. See
[`assistant.ts`](packages/ambion/src/assistant.ts) and
[`view.ts`](packages/ambion/src/room/view.ts).

### 8. Boundaries are small and serializable

The core depends on narrow host interfaces: `Clock`, `JournalOpener`,
`ModelResolver`, `Transport`, and `WorkspaceBackend`. One `JournalOpener`
persists room facts and Pi transcripts through separate names. Together they
isolate time, persistence, model resolution, seat execution, and workspace
storage from room semantics.

[`wire.ts`](packages/ambion/src/wire.ts) restricts room/seat traffic to plain
JSON values and five operations: `wake`, `cut`, `view`, `commit`, and `lease`.
An `ActivationSpec` identifies the input and tool granted to one activation.
The room uses that specification to render views and validate writes; the
executor uses it to bind tools. In-process and Cloudflare hosts share this
contract.

Workspace access follows the same design: an agent gets workspace tools only
when its definition names a workspace, and each call resolves access through
a backend. The core names the backend as a port and holds no filesystem.
`@ambionframework/workspace` provides an in-memory backend and one over a
real directory; stronger isolation can join behind the same interface. See
[`docs/workspace.md`](docs/workspace.md).

## A minimal sketch

```ts
import { defineAgent, defineHuman, startSession, visitSession } from '@ambionframework/ambion';

const materials = defineAgent({
  name: 'materials',
  identity: 'Owns stock levels and deliveries.',
  instructions: 'State a material constraint if one changes the answer; otherwise stay quiet.',
  model: 'anthropic/claude-sonnet-4-5',
  tools: [stockCheck],
});

const assistant = defineAgent({
  name: 'assistant',
  identity: 'Writes the one answer the person reads.',
  instructions: 'Lead with the decision, then only the facts it turns on.',
  model: 'anthropic/claude-sonnet-4-5',
});

const priya = defineHuman({
  name: 'priya',
  identity: 'Project manager responsible for the programme.',
  preferences: 'Four sentences at most.',
});

const session = startSession({
  name: 'site',
  goal: 'Keep the construction programme, materials, and labour plan consistent.',
  assistant,
  agents: [materials],
  available: [buildingControl, plantHire],
});

const visit = await visitSession(session, priya);
await visit.deliver({ text: 'Can I promise the client a Thursday pour?' });
await session.quiet();
```

The assistant may seat relevant reserve agents; the domain seats work in
parallel, and conflicting drafts get reconsidered against the newer record.
`quiet()` waits until the room has no work left, including any assistant
summary the exchange requires.

[`examples/site`](examples/site) is the runnable version: independently owned
agents, dynamically selected specialists, multiple people, workspace-backed
tools, and a full observable record. [`demos/`](demos) holds captured runs
with every activation shown.

## What is novel here

Ambion combines familiar distributed-systems mechanisms in a conversational
runtime:

- **Optimistic record concurrency for conversation.** Freshness is a runtime
  invariant, not model etiquette.
- **Synthesis as a separate agent responsibility.** Domain reasoning stays
  independent while one constrained seat consolidates the result.
- **Symmetric compaction.** Agent context and the human-facing view share the
  same summary without deleting the record.
- **Dynamic expertise as recorded state.** Selecting a specialist changes the
  replayable roster.
- **Quiescence as completion.** The actual liveness of seats closes work.
- **Presence in the event model.** Joining and leaving follow the same
  ordering and routing rules as speech.
- **Leases bridge the room and seat lifecycle.** Pending wakes plus claimed
  leases define whether the room still has work.

## Trajectory

The current implementation is an executable kernel for this application
architecture. Its direction follows from the boundaries already in the code:

1. **More durable hosts, same room semantics.** Storage, transport, clocks,
   models, and workspaces stay replaceable behind their interfaces.
2. **Process-separated seats.** The JSON-only wire protocol is the interface
   for moving an agent out of the room process while it keeps its activation
   and commit rules.
3. **Stronger workspace isolation.** Capability assignment stays on the agent
   definition; backends grow from local storage toward harder execution
   boundaries.
4. **Long-lived rooms with bounded model context.** Append-only history and
   summary-based views stay separate, so retention does not set prompt size.

Domain agents stay independently owned modules; everything they do together
stays legible in the room's record.

## Install

Ambion is published to GitHub Packages, which requires a token even for read
access. Create a [classic PAT](https://github.com/settings/tokens/new?scopes=read:packages&description=Ambion)
with `read:packages`, then add this to your project's `.npmrc`:

```ini
@ambionframework:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
export GITHUB_TOKEN=…
npm install @ambionframework/ambion
```

Agents that reach a workspace also need a backend:

```sh
npm install @ambionframework/workspace
```

The record the room writes to is
[`@ambionframework/journal`](packages/journal); the core depends on it, so it
arrives with the install above.

## Read the contracts

The design is specified in [`docs/agent.md`](docs/agent.md),
[`docs/exchange.md`](docs/exchange.md), [`docs/presence.md`](docs/presence.md),
[`docs/assistant.md`](docs/assistant.md), [`docs/roster.md`](docs/roster.md),
[`docs/workspace.md`](docs/workspace.md), and [`docs/durability.md`](docs/durability.md),
which says what the record promises when something fails. Build and
contribution instructions are in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[Apache 2.0](LICENSE)
