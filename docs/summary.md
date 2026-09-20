# Summaries

**A summary is an optional message for the person who opened a human
exchange.** The room assigns a writer by name. The name refers to one agent in
the room's `agents` catalog.

The writer is an ordinary agent. It has the same identity, instructions,
model, domain tools, membership, and attention rules as every other agent.
The room gives it a separate closing activation after the exchange closes.

## Shared context and compaction

**The human-facing summary is also the context for later agents.** This is the
accepted compaction model. Humans and agents continue from the same recorded
summary. The room does not maintain a separate summary for agent memory.

A summary replaces its covered source messages in later agent prompts. This
reduces context size and model cost. Summaries can omit details; this loss is
an accepted tradeoff. The journal retains the original discussion for application
reads and human review. Agents have no built-in source-retrieval tool.

Keep the current summary prompts and replacement behavior. Source retrieval,
pagination, and retaining all covered source in agent prompts are deferred.
Revisit this decision when demonstrated application needs justify a change.

## Configuration

Define every executable agent once in `agents`. Set `summary` to the name of
the agent that may write summaries.

```ts
const editor = defineAgent({
  name: 'editor',
  identity: 'Keeps decisions clear.',
  executor: pi({
    instructions: 'State facts that change the next action.',
    model: 'anthropic/claude-sonnet-5',
  }),
});

const room = await startRoom({
  name: 'delivery',
  agents: [inventory, scheduling, editor],
  summary: 'editor',
  seats: { inventory: 'broadcast', scheduling: 'broadcast', editor: 'broadcast' },
});
```

If `seats` is omitted, every defined agent starts as a member with
`broadcast` attention. An empty `seats` map starts every defined agent in the
reserve. The summary writer must be seated when the human exchange closes.
Otherwise that exchange has no summary assignment.

`startRoom({ assistant })` accepts an ordinary agent definition and supplies
its catalog entry, broadcast seat, and summary assignment. A conflicting
explicit summary writer is refused. This shorthand preserves the closing
activation and membership rules described here. See
[Default assistant](assistant.md) for the built-in implementation.

Every human exchange is eligible for a summary. Eligibility does not depend on
the number of messages or speakers. A room with no configured summary writer
still closes exchanges and retains their source messages.

## Closing activation

When the room records a close, it assigns a dedicated activation only when
`summary` names a seated agent. The activation fixes the exchange range and
the person who opened it. It receives that person's current preferences.
Later messages do not change the source range or recipient.

The closing activation reads every message through the end of its exchange.
A divider marks where its own exchange begins, so the writer can tell
background history from the exchange it covers. What it may write stays
fixed to that exchange. An `activationTokenLimit` windows this read the same
way it windows an ordinary activation, pinning the writer's own exchange
whole and trimming the background before it.

The closing activation receives the regular `say` tool with this shape:

```ts
say({ text: 'Thursday delivery is limited to eight units.', to: 'priya' });
```

The room supplies the recipient. A different recipient is refused. The room
stamps the writer, recipient, covered range, activation id, and timestamp on
the stored summary. The writer cannot supply or alter those fields.

The closing activation receives only `say`. The writer may decline by ending
without calling it; the source range then remains available to later agent
activations. The writer uses its domain and membership tools during ordinary
activations.

Summary publication wakes no idle agent and does not open another exchange.
The summary is a room record entry, so replay and response queries use the
same facts as the live room.

## Completion and reads

`exchange.waitForSummary()` resolves with the stored summary or `undefined` when no
summary is required or the writer declines. A failed or exhausted assignment
keeps the source discussion available and reports its terminal result through
the existing exchange contract.

Once a summary covers a closed range, later agent activations read the summary
in place of those source messages. `exchange.waitForClose()` always returns the
fixed source discussion for human review. The journal retains every entry.

If a pending assignment is removed because its writer leaves, the assignment
settles. Reseating that agent does not revive the old assignment. A later human
exchange can receive a new closing activation.

## Membership

All ordinary activations use the same membership operations. A live ordinary
activation may call `seat({ name })` or `unseat({ name })` and may call `say`.
The room refuses an unknown name. A request to seat an agent that is already
seated returns the existing no-op result and writes no journal entry, wake, or
acknowledgement. An agent may unseat itself.

Attention controls which messages wake an idle member. It does not create a
summary role or restrict an agent's tools. There is no scheduler, role system,
or capability framework in the room.

## History version

Composition entries use version 2. A room refuses a legacy composition and
does not reinterpret old assistant definitions or opening activation ids.
Start a new journal or migrate the history outside Ambion before resuming it.
